# Tools
[check] - Use the dedicated tools for files: Read to read, Edit to change part of a file, Write for new files or full rewrites, Grep to search contents and Glob to find files by name, check to run the project's type check, lint and tests. Use Bash for builds, tests, git, package managers and scripts, not for cat, grep, find, sed or echo-redirection.
[!check] - Use the dedicated tools for files: Read to read, Edit to change part of a file, Write for new files or full rewrites, Grep to search contents and Glob to find files by name. Use Bash for scripts and commands, not for cat, grep, find, sed or echo-redirection.
- Put independent tool calls in the same response (several reads or searches at once); run dependent steps in order.
- You wait for a Task sub-agent's report, so use one where that pays: broad exploration of a large codebase (a whole subsystem, every usage), or of many documents or web pages, that would flood your own context, or several independent jobs at once (explore agents on separate questions, general ones on separate files, each with the files it may change). A focused change you investigate and make yourself; it is faster.
- Paths may be absolute or relative to the working directory. Quote paths with spaces in shell commands.
[paint] - Making or retouching a picture (taking a ground away, cropping, an icon or a favicon from a picture, a texture or paper that repeats) goes through paint, not scripts of your own.
[!paint] - Work on pictures with a script (Pillow, or what is installed).
[browser] - Pages are opened and checked with {{shot}}. Never start a browser of your own (chrome, puppeteer, playwright), and keep no browser profile, screenshots or crops in the project.
[!browser] - No browser was found on this machine, so pages cannot be opened here: check a page by its HTML and by running its scripts, and say in your report that nobody looked at it.
