import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { run } from "./process.js";
import type {
  Config,
  DeliveryCompletion,
  PromotionConfig,
  RepositoryConfig,
  SessionDelivery,
} from "./types.js";

/**
 * Central delivery policy, format `sesh-integrator/delivery-policy@1`.
 * The canonical description is in docs/configuration.md#central-delivery-policy.
 */
export const DELIVERY_POLICY_SCHEMA = "sesh-integrator/delivery-policy@1";

/** An error whose `code` is reported in `sesh-integrator/error@1` documents. */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type DeliveryPromotion =
  | { type: "none" }
  | {
      type: "pull-request";
      mode: "shared-target" | "session-branch";
      productionBranch: string;
      remote: string;
      reviewers?: string[];
      assignees?: string[];
    };

export interface DeliveryRule {
  targetBranch: string;
  promotion: DeliveryPromotion;
  completion: DeliveryCompletion;
}

export interface DeliveryPolicy {
  schema: typeof DELIVERY_POLICY_SCHEMA;
  version?: string;
  defaults: DeliveryRule;
  repositories: Record<string, Partial<DeliveryRule>>;
}

export interface LoadedDeliveryPolicy {
  path: string;
  sha256: string;
  policy: DeliveryPolicy;
}

/** A conservative subset of Git branch names. */
const BRANCH =
  /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\.lock(?:\/|$)))[A-Za-z0-9._/-]+(?<![/.])$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** GitHub user, or org/team for reviewers. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;
/** Lowercase GitHub `owner/name`. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;
const COMPLETIONS: readonly DeliveryCompletion[] = [
  "local",
  "target-pushed",
  "production-merged",
];
const RULE_FIELDS = ["targetBranch", "promotion", "completion"] as const;

type Issues = string[];
type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function rejectUnknown(
  value: Json,
  allowed: readonly string[],
  path: string,
  issues: Issues,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) issues.push(`${at(path, key)}: unknown field`);
}

function parseBranch(
  value: unknown,
  path: string,
  issues: Issues,
): string | undefined {
  if (typeof value === "string" && value.length <= 200 && BRANCH.test(value))
    return value;
  issues.push(`${path}: must be a branch name`);
  return undefined;
}

function parseLogins(
  value: unknown,
  max: number,
  path: string,
  issues: Issues,
): string[] | undefined {
  if (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string" && LOGIN.test(item))
  )
    return [...(value as string[])];
  issues.push(
    `${path}: must be at most ${max} GitHub logins or org/team names`,
  );
  return undefined;
}

function parsePromotion(
  value: unknown,
  path: string,
  issues: Issues,
): DeliveryPromotion | undefined {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  if (value.type === "none") {
    rejectUnknown(value, ["type"], path, issues);
    return { type: "none" };
  }
  if (value.type !== "pull-request") {
    issues.push(`${at(path, "type")}: must be "none" or "pull-request"`);
    return undefined;
  }
  rejectUnknown(
    value,
    ["type", "mode", "productionBranch", "remote", "reviewers", "assignees"],
    path,
    issues,
  );
  const mode = value.mode ?? "shared-target";
  if (mode !== "shared-target" && mode !== "session-branch")
    issues.push(
      `${at(path, "mode")}: must be "shared-target" or "session-branch"`,
    );
  const productionBranch = parseBranch(
    value.productionBranch ?? "main",
    at(path, "productionBranch"),
    issues,
  );
  const remote = value.remote ?? "origin";
  if (typeof remote !== "string" || !REMOTE.test(remote))
    issues.push(`${at(path, "remote")}: must be a Git remote name`);
  const reviewers =
    value.reviewers === undefined
      ? undefined
      : parseLogins(value.reviewers, 15, at(path, "reviewers"), issues);
  const assignees =
    value.assignees === undefined
      ? undefined
      : parseLogins(value.assignees, 10, at(path, "assignees"), issues);
  return {
    type: "pull-request",
    mode: mode as "shared-target" | "session-branch",
    productionBranch: productionBranch ?? "",
    remote: remote as string,
    ...(reviewers ? { reviewers } : {}),
    ...(assignees ? { assignees } : {}),
  };
}

function parseRule(
  value: unknown,
  path: string,
  issues: Issues,
  partial: boolean,
): Partial<DeliveryRule> | undefined {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  rejectUnknown(value, RULE_FIELDS, path, issues);
  const rule: Partial<DeliveryRule> = {};
  for (const field of RULE_FIELDS)
    if (value[field] === undefined && !partial)
      issues.push(`${at(path, field)}: required`);
  if (value.targetBranch !== undefined) {
    const branch = parseBranch(
      value.targetBranch,
      at(path, "targetBranch"),
      issues,
    );
    if (branch) rule.targetBranch = branch;
  }
  if (value.promotion !== undefined) {
    const promotion = parsePromotion(
      value.promotion,
      at(path, "promotion"),
      issues,
    );
    if (promotion) rule.promotion = promotion;
  }
  if (value.completion !== undefined) {
    if (COMPLETIONS.includes(value.completion as DeliveryCompletion))
      rule.completion = value.completion as DeliveryCompletion;
    else
      issues.push(
        `${at(path, "completion")}: must be one of ${COMPLETIONS.join(", ")}`,
      );
  }
  return rule;
}

/** An override replaces whole top-level fields; `promotion` is never deep-merged. */
function applyOverride(
  defaults: DeliveryRule,
  override: Partial<DeliveryRule> | undefined,
): DeliveryRule {
  return {
    targetBranch: override?.targetBranch ?? defaults.targetBranch,
    promotion: override?.promotion ?? defaults.promotion,
    completion: override?.completion ?? defaults.completion,
  };
}

/** Why a resolved rule is inconsistent, or null. */
export function ruleProblem(rule: DeliveryRule): string | null {
  const { promotion, completion } = rule;
  if (promotion.type === "none")
    return completion === "local"
      ? null
      : 'promotion "none" pushes nothing, so completion must be "local"';
  if (promotion.productionBranch === rule.targetBranch)
    return "productionBranch must differ from targetBranch";
  if (promotion.mode === "session-branch" && completion === "target-pushed")
    return 'session-branch mode never pushes the target, so completion cannot be "target-pushed"';
  return null;
}

/** Strictly validate a parsed policy document; returns it normalized. */
export function parseDeliveryPolicy(
  value: unknown,
):
  | { policy: DeliveryPolicy; issues: [] }
  | { policy?: undefined; issues: string[] } {
  const issues: Issues = [];
  if (!isObject(value)) return { issues: ["policy: must be a JSON object"] };
  rejectUnknown(
    value,
    ["schema", "version", "defaults", "repositories"],
    "",
    issues,
  );
  if (value.schema !== DELIVERY_POLICY_SCHEMA)
    issues.push(`schema: must be "${DELIVERY_POLICY_SCHEMA}"`);
  if (
    value.version !== undefined &&
    (typeof value.version !== "string" ||
      value.version.length < 1 ||
      value.version.length > 128)
  )
    issues.push("version: must be a string of 1 to 128 characters");
  const defaults = parseRule(value.defaults, "defaults", issues, false);
  const repositories: Record<string, Partial<DeliveryRule>> = {};
  if (value.repositories !== undefined) {
    if (!isObject(value.repositories))
      issues.push("repositories: must be an object");
    else
      for (const [key, entry] of Object.entries(value.repositories)) {
        const path = `repositories.${key}`;
        if (!SLUG.test(key))
          issues.push(`${path}: key must be a lowercase GitHub owner/name`);
        const override = parseRule(entry, path, issues, true);
        if (override) repositories[key] = override;
      }
  }
  if (issues.length) return { issues };
  const rule = defaults as DeliveryRule;
  const problem = ruleProblem(rule);
  if (problem) issues.push(`defaults: ${problem}`);
  for (const [key, override] of Object.entries(repositories)) {
    const repositoryProblem = ruleProblem(applyOverride(rule, override));
    if (repositoryProblem)
      issues.push(`repositories.${key}: ${repositoryProblem}`);
  }
  if (issues.length) return { issues };
  return {
    policy: {
      schema: DELIVERY_POLICY_SCHEMA,
      ...(value.version !== undefined
        ? { version: value.version as string }
        : {}),
      defaults: rule,
      repositories,
    },
    issues: [],
  };
}

/** Read, hash and validate a policy file; fails with policy_missing or policy_invalid. */
export async function loadDeliveryPolicy(
  path: string,
): Promise<LoadedDeliveryPolicy> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "not found"
        : `cannot be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`;
    throw new CodedError(
      "policy_missing",
      `Delivery policy file ${path} ${reason}`,
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CodedError(
      "policy_invalid",
      `Invalid delivery policy ${path}: not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = parseDeliveryPolicy(value);
  if (!parsed.policy) {
    const shown = parsed.issues.slice(0, 20);
    if (parsed.issues.length > shown.length)
      shown.push(`and ${parsed.issues.length - shown.length} more`);
    throw new CodedError(
      "policy_invalid",
      `Invalid delivery policy ${path}: ${shown.join("; ")}`,
    );
  }
  return { path, sha256, policy: parsed.policy };
}

/** The rule for `owner/name`: its repository entry over `defaults`. */
export function resolveDeliveryRule(
  policy: DeliveryPolicy,
  repository: string,
): DeliveryRule & { repository: string; source: "repository" | "defaults" } {
  const slug = repository.toLowerCase();
  if (!SLUG.test(slug))
    throw new CodedError(
      "usage",
      `Repository must be a GitHub owner/name, got ${JSON.stringify(repository)}`,
    );
  const override = Object.hasOwn(policy.repositories, slug)
    ? policy.repositories[slug]
    : undefined;
  return {
    ...applyOverride(policy.defaults, override),
    repository: slug,
    source: override ? "repository" : "defaults",
  };
}

/** Lowercase `owner/name` from a GitHub fetch URL, or null for anything else. */
export function repositoryFromRemoteUrl(url: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match) return null;
  const slug = `${match[1]}/${match[2]}`.toLowerCase();
  return SLUG.test(slug) ? slug : null;
}

/**
 * Identify the repository from the configured fetch URL (before `insteadOf`
 * rewriting) of the policy's default promotion remote, or `origin` when that
 * remote is not configured or the default promotion is `none`.
 */
export async function repositoryIdentity(
  repositoryPath: string,
  policy: DeliveryPolicy,
): Promise<string> {
  const candidates = [
    ...(policy.defaults.promotion.type === "pull-request"
      ? [policy.defaults.promotion.remote]
      : []),
    "origin",
  ];
  for (const remote of [...new Set(candidates)]) {
    const configured = await run(
      "git",
      ["config", "--get-all", `remote.${remote}.url`],
      { cwd: repositoryPath },
    );
    const url = configured.code === 0 ? configured.stdout.split("\n")[0] : "";
    if (!url) continue;
    const slug = repositoryFromRemoteUrl(url);
    if (slug) return slug;
    throw new CodedError(
      "repository_unidentified",
      `Delivery policy needs a GitHub repository identity, but remote ${remote} fetch URL is not a GitHub https, git@ or ssh URL`,
    );
  }
  throw new CodedError(
    "repository_unidentified",
    `Delivery policy needs a GitHub repository identity, but no ${[...new Set(candidates)].join(" or ")} remote is configured`,
  );
}

/** The policy file `begin` uses: `--policy-file`, else global `deliveryPolicyFile`. */
export function deliveryPolicyPath(
  policyFile: string | undefined,
  config: Config,
  configPath: string,
): string | undefined {
  if (policyFile) return resolve(process.cwd(), policyFile);
  if (config.deliveryPolicyFile)
    return resolve(dirname(configPath), config.deliveryPolicyFile);
  return undefined;
}

/** Load the policy and resolve the delivery rule to record on a new session. */
export async function resolveSessionDelivery(
  path: string,
  repository: RepositoryConfig,
): Promise<SessionDelivery> {
  const loaded = await loadDeliveryPolicy(path);
  const identity = await repositoryIdentity(repository.path, loaded.policy);
  const rule = resolveDeliveryRule(loaded.policy, identity);
  if (rule.targetBranch === repository.integrationBranch)
    throw new CodedError(
      "policy_conflict",
      `Delivery policy target ${rule.targetBranch} for ${identity} is this repository's staging integration branch; choose a different targetBranch or integrationBranch`,
    );
  return {
    version: loaded.policy.version ?? null,
    sha256: loaded.sha256,
    repository: rule.repository,
    targetBranch: rule.targetBranch,
    promotion: rule.promotion,
    completion: rule.completion,
    source: rule.source,
  };
}

/**
 * The repository configuration a session runs under: its recorded delivery
 * rule replaces `targetBranch` and `promotion`. Omitted reviewers and
 * assignees still fall back to the global `defaultPromotion`.
 */
export function withDelivery(
  repository: RepositoryConfig,
  delivery: SessionDelivery | undefined,
): RepositoryConfig {
  if (!delivery) return repository;
  const effective: RepositoryConfig = {
    ...repository,
    targetBranch: delivery.targetBranch,
    promotion: delivery.promotion as PromotionConfig,
  };
  for (const key of [
    "globalDefaultTargetBranch",
    "globalDefaultPromotion",
  ] as const)
    Object.defineProperty(effective, key, {
      value: repository[key],
      configurable: true,
      enumerable: false,
      writable: true,
    });
  return effective;
}

/** The remote `begin --sync-target` fetches: the rule's promotion remote, else origin. */
export function syncRemote(repository: RepositoryConfig): string {
  return repository.promotion?.type === "pull-request"
    ? (repository.promotion.remote ?? "origin")
    : "origin";
}

const POLICY_USAGE =
  "Usage: seshx policy check --file <path> [--repository <owner/name>]";

/**
 * `seshx policy check`: validate a policy file and return it normalized, or,
 * with `--repository`, the rule `begin` would record for that repository.
 */
export async function policyCommand(
  args: string[],
): Promise<Record<string, unknown>> {
  const [action, ...rest] = args;
  if (action !== "check") throw new CodedError("usage", POLICY_USAGE);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!;
    const value = rest[index + 1];
    if (!["--file", "--repository"].includes(key) || !value || values.has(key))
      throw new CodedError("usage", POLICY_USAGE);
    values.set(key, value);
  }
  const file = values.get("--file");
  if (!file) throw new CodedError("usage", POLICY_USAGE);
  const loaded = await loadDeliveryPolicy(resolve(process.cwd(), file));
  const repository = values.get("--repository");
  if (!repository) return { ...loaded.policy };
  const rule = resolveDeliveryRule(loaded.policy, repository);
  return {
    version: loaded.policy.version ?? null,
    sha256: loaded.sha256,
    repository: rule.repository,
    targetBranch: rule.targetBranch,
    promotion: rule.promotion,
    completion: rule.completion,
    source: rule.source,
  };
}
