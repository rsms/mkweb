# mkweb

mkweb is a simple static website generator for NodeJS

Features:

- Simple and fast
- Templates (currently hard coded to "template.html")
- Markdown with code-syntax highlighting
- Front matter (for both markdown and html pages)
- Incremental updates ("watch the filesystem" kind of thing)
- Livereload local webserver


Usage:

1. make a directory and put some html, css and/or md files in there
2. install mkweb from NPM: `npm i rsms-mkweb`
3. run mkweb in that directory: `./node_modules/.bin/mkweb`
4. your website can be found in `_site`

See `mkweb -h` for customization options and extra features
