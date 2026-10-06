// Run before scenario imports: theme-context captures terminal capabilities
// once at module load. The in-process test renderer supports full RGB.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "3";
process.env.TERM = "xterm-256color";
process.env.COLORTERM = "truecolor";
