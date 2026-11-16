# Tools
[check] - Work on files with the file tools and run the project's type check, lint and tests with check. Use shell for builds, tests, git, package managers and scripts, not for cat, grep, find, sed or redirection.
[!check] - Work on files with the file tools. Use shell for scripts and commands, not for cat, grep, find, sed or redirection.
- Gather what a step needs in one go: read all the files you need together (up to 40 paths in one read call) and put independent searches and commands in the same response; run dependent steps in order. When a change spans files (the fix and its test, a function and its callers), send all of its edits in one response.
- You wait for an agent's report, so use agent where that pays: a part your next steps do not need, with a dozen or more tool calls of its own, that returns something you use as it is. That is several independent jobs at once (explore agents on separate questions, general agents on separate files, each with the files it may change), or broad exploration of a large codebase, or of many documents or web pages, that would flood your own context. A single change, a fix or anything that goes step by step you do yourself, faster, and an agent never checks your own work.
- Paths may be absolute or relative to the working directory. Quote paths with spaces in shell commands.
[paint] - Making or retouching a picture (taking a ground away, cropping, an icon or a favicon from a picture, a texture or paper that repeats) goes through paint, not scripts of your own.
[!paint] - Work on pictures with a script (Pillow, or what is installed).
[browser] - Pages are opened and checked with {{shot}}. Never start a browser of your own (chrome, puppeteer, playwright), and keep no browser profile, screenshots or crops in the project.
[!browser] - No browser was found on this machine, so pages cannot be opened here: check a page by its HTML and by running its scripts, and say in your report that nobody looked at it.
