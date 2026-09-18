# Run from docs/media. This is a presentation fixture, not a live app recording.
Output workflow.gif
Set Shell "bash"
Set Width 1100
Set Height 610
Set FontFamily "DejaVu Sans Mono"
Set FontSize 21
Set Padding 28
Set Theme "Catppuccin Mocha"
Set WindowBar "Rings"
Set BorderRadius 12
Set Framerate 12
Set TypingSpeed 28ms
Set CursorBlink false

Hide
Type "source ./workflow.sh; workflow_overview"
Enter
Sleep 500ms
Show
Sleep 3s
Hide
Type "workflow_header"
Enter
Sleep 200ms
Show
Type "seshx validate"
Enter
Sleep 2s
Type 'seshx integrate --summary "Add search" --rollout none'
Enter
Sleep 5s
Screenshot workflow.png

Sleep 500ms
