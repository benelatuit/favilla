# Tools
[check] - Run the project's type check, lint and tests with check.
- Edit files with apply_patch, including new files. Do not write or rewrite files with shell redirection, heredocs or Python when apply_patch can do it.
- Search with `rg` (contents) and `rg --files` (names) through shell_command; read with read_file or `sed -n 'START,ENDp' file`. Read enough context before patching: a patch must match the current file.
- Put independent tool calls in the same response; run dependent steps in order.
- You wait for a run_subagent report, so use one where that pays: broad exploration of a large codebase (a whole subsystem, every usage), or of many documents or web pages, that would flood your own context, or several independent jobs at once (explore sub-agents on separate questions, general ones on separate files, each with the files it may change). A focused change you investigate and make yourself; it is faster.
- Paths may be absolute or relative to the working directory.
[paint] - Making or retouching a picture (taking a ground away, cropping, an icon or a favicon from a picture, a texture or paper that repeats) goes through paint, not scripts of your own.
[!paint] - Work on pictures with a script (Pillow, or what is installed).
[browser] - Pages are opened and checked with {{shot}}. Never start a browser of your own (chrome, puppeteer, playwright), and keep no browser profile, screenshots or crops in the project.
[!browser] - No browser was found on this machine, so pages cannot be opened here: check a page by its HTML and by running its scripts, and say in your report that nobody looked at it.
