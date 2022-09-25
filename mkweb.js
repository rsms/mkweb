#!/usr/bin/env node
const fs = require("fs")
const fsp = require("fs").promises
const Path = require("path")
const vm = require("vm")
const inspect = require("util").inspect
const glob = require("miniglob").glob
const md = require("markdown-wasm")
// const hljs = require('highlight.js/lib/core')
const hljs = require('highlight.js/lib/common')
const { createServer } = require("serve-http")

const template_cache = new Map()
const buf_lf_dash_x3 = Buffer.from("\n---")
const self_mtime = fs.statSync(__filename).mtimeMs

const dirname = Path.dirname
const basename = Path.basename
const pathresolve = Path.resolve
const pathjoin = Path.join
const relpath = Path.relative
const extname = Path.extname
const fmtjson = JSON.stringify.bind(JSON)

let VERBOSE = false
let OPTIMIZE = false
let DEPS = Symbol("DEPS")
let DEPFILES = Symbol("DEPFILES")
let DYNFILES = Symbol("DYNFILES")
let CFGFILE = Symbol("CFGFILE")
let ERRCOUNT = Symbol("ERRCOUNT")
let ISBUILDING = Symbol("ISBUILDING")
let BODY_LINE_OFFSET = Symbol("")

const KIND_PAGE = "page"
const KIND_CSS  = "css"
const KIND_DATA = "data"

function log() {
  if (VERBOSE)
    console.error.apply(console, arguments)
}
function log_important() {
  console.error.apply(console, arguments)
}

function die(msg) {
  console.error(`${basename(__filename)}: ${msg}`)
  process.exit(1)
}


function create_site_object() { return {
  __proto__: { title: "", },
  srcdir: ".",
  outdir: "_site",
  pages: [],
  root: null, // root "index" page
  defaultTemplate: "",
  baseURL: "/",
  buildHash: Date.now().toString(36),
  fileTypes: { // lower(filename_ext) => type
    ".md": "md",
    ".mdown": "md",
    ".markdown": "md",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
  },
  fileKinds: { // type => KIND_*
    "md": KIND_PAGE,
    "html": KIND_PAGE,
    "css": KIND_CSS,
  },
  pageRenderers: { // keyed on fileTypes
    "md": render_page_md,
    "html": render_page_html,
  },

  // ignoreFilter returns true for files that should be excluded from output.
  // name is the base of the file (no directory), path is "absolute" as if the
  // file system is rooted in site.srcdir. Both name and path is toLowerCase().
  ignoreFilter(name, path) {
    return path.startsWith(".") || path.startsWith("_") || path.includes("/.")
        || path == "node_modules"
        || path == "readme.md"
        || name == "package.json"
        || name == "package-lock.json"
  },

  // ignoreWatchFilter is called when a source file changes.
  // Return true to ignore the change, not causing a rebuild.
  // Useful when generating source files in onBeforeBuild or onAfterBuild.
  ignoreWatchFilter(name, path) {
    return false
  },

  // templateHelpers are things available in template's global scope.
  // A helper that is a function is called with the current page scope as "this".
  // File-based helpers should treat relative paths as relative to the current page.
  templateHelpers: {
    // html_encode(text :string) :string
    html_encode,
    // mtime(path :string) :number  -- returns 0 on failure
    mtime,
    // readfile(path :string, encoding :string = "utf8") :string
    readfile(path, encoding) {
      path = pathresolve(dirname(this.page.srcfile), path)
      return fs.readFileSync(path, {encoding: encoding === undefined ? "utf8" : encoding})
    },
    // include(path :string, encoding :string = "utf8") :string
    include(path, encoding) {
      return this.readfile(path, encoding)
    },
    // cacheBustFileURL(filename :string) :string -- e.g. "foo.css" -> "foo.css?g0zr0dbgtw"
    cacheBustFileURL(path) {
      const filename = pathjoin(dirname(this.page.srcfile), path)
      const mtime = mtime_with_deps(this.site, filename)
      return path + "?" + Math.round(mtime).toString(36)
    },
    // renderMarkdown(src :string|ArrayLike<number>) :string -- returns html
    // Example: {{! renderMarkdown(readfile("README.md", null)) }}
    renderMarkdown: render_markdown,
    url(destination) {
      let dstpath = ""
      if (destination && typeof destination == "object" && destination.srcfile) {
        // page object
        dstpath = destination.srcfile
        if (destination.srctype == "md") {
          dstpath = dstpath.substr(0, dstpath.lastIndexOf(".")) + ".html"
        }
      } else {
        dstpath = pathresolve(this.site.srcdir, destination ? String(destination) : "")
      }
      dstpath = relpath(dirname(this.page.srcfile), dstpath)
      return dstpath
    },
    basename: basename,
    dirname: dirname,
    relpath: relpath,
    cwd() { return process.cwd() },

    // print(...args :any[]) -- write to template output buffer
    print(...args) {} // implemented in render_template

  }, // END templateHelpers

  // optional callbacks (can return a Promise to cause build process to wait)
  onBeforeBuild(files) {}, // called when site.pages has been populated
  onAfterBuild(files) {},  // called after site has been generated

  // internal state
  [ERRCOUNT]: 0,
  [DEPS]: new Map(),          // dependency mappings, used in watch mode
  [DEPFILES]: new Set(),      // values of DEPS
  [DYNFILES]: new Map(), // used in watch mode
}}


async function main(argv) {
  let site = create_site_object()
  const opt = cli_parseopt(argv, [
    // flags,          kind,   [description, [default]]
    [["help", "h"],    "true", `Show help and exit`],
    [["watch", "w"],   "true", `Watch files for changes and rebuild`],
    [["verbose", "v"], "true", `Print details on stderr`],
    [["outdir"],       "path", `Output directory`, site.outdir],
    [["http"],         "addr", `In watch mode, bind to HTTP addr`, "localhost:3000"],
    [["incr"],         "true", `Incrementally build into existing outdir`],
    [["opt", "O"],     "true", `Produce compact output at the expense of time`],
    [["config"],       "file", `JS file to load as module & call with site state`],
  ])
  VERBOSE = opt.verbose
  OPTIMIZE = opt.opt
  if (opt.help) {
    cli_usage(opt._options)
    process.exit(0)
  }
  if (opt.args.length > 0) {
    site.srcdir = opt.args[0]
    if (opt.args.length > 1)
      die(`unexpected extra arguments: ${opt.args.slice(1).join(" ")}`)
  }

  // load config from file
  site.srcdir = pathresolve(site.srcdir)
  site.outdir = opt.outdir
  load_config(site, opt)

  // source and output directories
  site.srcdir = pathresolve(site.srcdir)
  site.outdir = pathresolve(site.srcdir, site.outdir)
  mtime(site.srcdir) > 0 || die(`srcdir "${site.srcdir}" not found`)
  site.srcdir != site.outdir || die(`srcdir is same as outdir ("${site.srcdir}")`)
  site.srcdir_inside_outdir = is_parent_dir(site.outdir, site.srcdir)

  // default template
  configure_default_template(site)

  // check site.baseURL
  if (opt.watch) {
    site.baseURL = "/"
  } else if (!site.baseURL || !site.baseURL.endsWith("/")) {
    die(`site.baseURL "${site.baseURL}" does not end with "/"`)
  }

  // log info
  if (VERBOSE) {
    log(`srcdir: ${nicepath(site.srcdir)}`)
    log(`outdir: ${nicepath(site.outdir)}`)
  }

  // wipe outdir unless this is an incremental build
  if (!opt.incr)
    await clear_outdir(site)

  // build the site
  await build_site(site)

  // incrementally build as files change (if requested)
  if (opt.watch)
    return watch_serve_and_rebuild(site, opt.http)

  return site[ERRCOUNT] > 0 ? 1 : 0
}


async function clear_outdir(site) {
  if (!site.srcdir_inside_outdir) {
    fs.rmSync(site.outdir, { recursive: true, force: true })
    return
  }
  // outdir is a parent directory of srcdir -- proceed with caution
  let dirents
  try {
    dirents = fs.readdirSync(site.outdir)
  } catch (err) {
    if (err.code != 'EEXIST') {
      log("error while cleaning outdir")
      throw err
    }
  }
  let promises = []
  for (let fn of dirents) {
    let path = pathjoin(site.outdir, fn)
    if (!is_parent_dir(site.srcdir, path)) {
      log(`rm {outdir}/${fn}`)
      promises.push(fsp.rm(path, { recursive: true, force: true }))
    }
  }
  await Promise.all(promises)
}


// is_parent_dir returns true if parentdir is a parent of subdir.
// It assumes both paths are absolute and does not end in "/".
// e.g. is_parent_dir("/a/b", "/a/b/c") => true
//      is_parent_dir("/a/b", "/a/b")   => true
//      is_parent_dir("/a/b", "/a")     => false
//      is_parent_dir("/a/b", "/a/x")   => false
//
// outdir = /Users/rsms/src/rsms.me/rsm
// srcdir = /Users/rsms/src/rsms.me/rsm/_src
//
function is_parent_dir(parentdir, subdir) {
  return subdir == parentdir || subdir.startsWith(parentdir + "/")
}


function configure_default_template(site, opt) {
  let file = site.defaultTemplate
  if (file) {
    file = pathresolve(site.srcdir, file)
    if (!isfile(file))
      die(`default template file ${site.defaultTemplate} not found`)
  } else {
    file = pathjoin(site.srcdir, "_template.html")
    if (!isfile(file))
      return
  }
  site.defaultTemplate = file
  log(`using default template ${nicepath(file)}`)
}


function load_config(site, opt) {
  let file = opt.config
  if (file) {
    file = pathresolve(file)
    if (!isfile(file))
      die(`config file ${opt.config} not found`)
  } else {
    file = pathjoin(site.srcdir, "_config.js")
    if (!isfile(file))
      return
  }

  log(`loading config file ${nicepath(file)}`)
  site[CFGFILE] = file

  const f = require(file)

  if (typeof f != "function")
    die(`${nicepath(opt.config)} does not export a function (found ${typeof f})`)

  f({
    site,
    hljs,
    markdown: md,
    glob,
    mtime,
    copy_file,
    write_file,
    read_file: fsp.readFile,
    build_site() { return build_site(site) },
  })
}


function cli_parseopt(args, options) {
  let result = {
    _options: options,
    args: [], // unparsed args
  }
  const argmap = {}
  const aliasmap = {}
  for (let [flags, kind, descr, defaultval] of options) {
    const flag = flags[0]
    let parse = null
    switch (kind) {
      case "true":
        result[flag] = false
        parse = (_) => result[flag] = true
        break
      case "false":
        result[flag] = true
        parse = (_) => result[flag] = false
        break
      default:
        result[flag] = defaultval || ""
        parse = (nextarg) => result[flag] = nextarg()
    }
    for (let flag of flags) {
      argmap[flag] = parse
    }
  }
  for (let i = 0; i < args.length; i++) {
    let arg = args[i]
    const nextarg = () => {
      return args[++i] || die(`missing value for argument ${arg} ${kind}`)
    }
    if (arg[0] == "-") {
      const flag = arg.substr(1)
      const parse = argmap[flag] || die(`unexpected argument ${arg}`)
      parse(nextarg)
    } else {
      result.args.push(arg)
    }
  }
  return result
}


function cli_usage(options) {
  let usage = `
    Build a website.
    usage: ${basename(__filename)} [options] [<srcdir>]
    <srcdir> defaults to the current directory.
    options:
  `.replace(/\n    /gm, "\n").trim()
  let col1_width = 0
  const options_str = options.map(([flags, kind, descr, defaultval]) => {
    let col1 = flags.map(flag => {
      return "-" + flag
    }).join(", ")
    if (kind != "true" && kind != "false")
      col1 += ` <${kind}>`
    col1_width = Math.max(col1.length, col1_width)
    return [col1, descr, defaultval]
  })
  for (let [args, descr, defaultval] of options_str) {
    if (descr) {
      usage += `\n  ${args.padEnd(col1_width)}  ${descr}`
    } else {
      usage += `\n  ${args}`
    }
    if (defaultval !== undefined)
      usage += ` (default ${fmtjson(defaultval)})`
  }
  process.stderr.write(usage + "\n")
}


function include_srcfile(site, basename, abspath) {
  if (abspath == site.srcdir || site.srcdir.startsWith(abspath + "/"))
    return false
  let relpath = abspath.substr(site.srcdir.length + 1).toLowerCase()
  return !site.ignoreFilter(basename.toLowerCase(), relpath)
}


// called when a file changes
// return true to "react" to the change; rebuild
function should_react_to_file_change(site, relpath) {
  const abspath = pathjoin(site.srcdir, relpath)
  const name = basename(relpath)

  // ignore changes in outdir
  if (!site.srcdir_inside_outdir && is_parent_dir(site.outdir, abspath))
    return false

  if (site.ignoreWatchFilter(name.toLowerCase(), relpath.toLowerCase()))
    return false

  if (include_srcfile(site, name, abspath))
    return true

  if (site[DEPFILES].has(abspath) || template_cache.has(abspath))
    return true

  return false
}


function watch_serve_and_rebuild(site, bindaddr) {
  let [host, portstr] = bindaddr.split(":", 2)
  let port = parseInt(portstr)
  if (!port || isNaN(port)) {
    port = parseInt(host)
    if (port.toString() == host) {
      host = ""
    } else {
      port = 3000
    }
  }
  if (!host)
    host = "localhost"
  const http_server = createServer({ pubdir: site.outdir, host, port, quiet: true })
  const outdir_rel = relpath(site.srcdir, site.outdir) + "/"
  let rebuild_timer = null
  const fswatcher = fs.watch(site.srcdir, { recursive: true }, (event, filename) => {
    if (!should_react_to_file_change(site, filename))
      return
    // wait a bit in case many files changed
    log(event, filename)
    clearTimeout(rebuild_timer)
    rebuild_timer = setTimeout(() => build_site(site), 50)
  })
  log_important(`watching ${nicepath(site.srcdir)} and serving site at http://${host}:${port}/`)
  return new Promise(resolve => http_server.once("close", resolve))
}


async function build_site(site) {
  // handle calls to build_site while build is in progress

  // wait for ongoing build
  if (site[ISBUILDING])
    await site[ISBUILDING]

  // start new build
  site[ISBUILDING] = build_site1(site).then(result => {
    site[ISBUILDING] = null
    return result
  }).catch(err => {
    site[ISBUILDING] = null
    throw err
  })
  return await site[ISBUILDING]
}


async function build_site1(site) {
  console.time("build site")
  // clear templates cache on each rebuild in case any changed
  template_cache.clear()
  site[DEPFILES] = new Set()
  if (site[CFGFILE])
    site[DEPFILES].add(site[CFGFILE])

  // find source files
  const specialFiles = {} // keyed by KIND_*
  const add_special_file = (kind, filename) => {
    if (specialFiles[kind] === undefined) {
      specialFiles[kind] = [filename]
    } else {
      specialFiles[kind].push(filename)
    }
  }
  const dataFiles = await find_files(site.srcdir, ent => {
    if (!include_srcfile(site, ent.name, ent.path))
      return false
    if (ent.path == site.defaultTemplate || ent.path == site.outdir)
      return false
    if (ent.isFile()) {
      // check if the file is of a special kind (page, css, etc.)
      // e.g. foo.mDown -> .mdown -> md -> KIND_PAGE
      const kind = site.fileKinds[site.fileTypes[extname(ent.name).toLowerCase()]]
      if (kind && kind != KIND_DATA) {
        add_special_file(kind, ent.path)
        return false
      }
    }
    return true // include
  })

  // load pages
  site.pages = await Promise.all((specialFiles[KIND_PAGE] || []).map(fn =>
    load_page(site, fn) ))

  // connect parent & child info
  connect_pages(site)

  // set default site title
  if (!site.title)
    site.__proto__.title = basename(site.srcdir)

  if (site.onBeforeBuild) {
    const p = site.onBeforeBuild({dataFiles, specialFiles})
    if (p instanceof Promise)
      await p
  }

  // generate site
  await gen_site(site, dataFiles, specialFiles[KIND_CSS] || [])

  if (site.onAfterBuild) {
    const p = site.onAfterBuild({dataFiles, specialFiles})
    if (p instanceof Promise)
      await p
  }

  console.timeEnd("build site")
}


function connect_pages(site) {
  if (site.pages.length == 0)
    return

  site.pages.sort((a, b) => {
    const aurl = path_without_ext(a.url).replace(/\/+$/, "")
    const burl = path_without_ext(b.url).replace(/\/+$/, "")
    return aurl < burl ? -1 : burl < aurl ? 1 : 0
  })

  let parent = null
  let parentStack = []
  let pdir = ""

  if (site.pages[0].url == "/") {
    site.root = site.pages[0]
    if (site.root.header.site_title) {
      site.__proto__.title = site.root.header.site_title
    } else if (!site.title) {
      site.__proto__.title = site.root.title
    }
  }

  for (let p of site.pages) {
    p.parent = parent
    const dir = dirname(p.srcfile)
    if (dir == pdir) {
      parent.children.push(p)
    } else {
      if ((pdir + Path.sep).startsWith(dir)) {
        // leave
        parent = parentStack.pop()
      } else {
        // enter
        if (parent) {
          parent.children.push(p)
          parentStack.push(parent)
        }
        parent = p
      }
      pdir = dir
    }
  }
}


async function gen_site(site, datafiles, cssfiles) {
  return Promise.all([
    copy_files_to_dir(site, datafiles, site.outdir),
    cssfiles.length > 0 ? gen_cssfiles(site, cssfiles) : Promise.resolve(),
    ... site.pages.map(page => gen_page(site, page))
  ])
}


function Page() {}


async function load_page(site, srcfile) {
  // load markdown source
  const [srcbuf, srcmtime] = await Promise.all([
    fsp.readFile(srcfile),
    fsp.stat(srcfile).then(st => st.mtimeMs) ])

  const fileext = extname(srcfile)
  const srctype = site.fileTypes[fileext.toLowerCase()]

  let url = site.baseURL + relpath(site.srcdir, srcfile)
  if (srctype != "html")
    url = url.substr(0, url.length - fileext.length) + ".html"
  if (basename(url).toLowerCase() == "index.html")
    url = url.substr(0, url.length - ("index.html").length)

  const page = { __proto__: Page.prototype,
    srcfile:  srcfile,
    srctype:  srctype,
    srcmtime: srcmtime,
    srcbuf:   srcbuf,
    title:    "",
    url:      url,
    header:   {},
    template: "",
    body:     "",
    parent:   null,
    children: [],

    [inspect.custom](depth, options) {
      const p = Object.assign(Object.create(page.__proto__), page)
      delete p.body    // unreliable during template evaluation
      if (p.srcbuf) p.srcbuf = {
        // reused across MD pages; when printing children it would show same content
        [inspect.custom](depth, options) { return `<Buffer>` }
      }
      if (p.parent) p.parent = {
        [inspect.custom](depth, options) {
          return `<Page ${fmtjson(page.parent.url)}>`
        }
      }
      delete p[inspect.custom]
      delete p[BODY_LINE_OFFSET]
      return p
    }
  }

  // parse header aka "frontmatter"
  const { header, bodyindex, linecount } = parse_md_header(srcbuf, srcfile)
  if (bodyindex > 0) {
    page.srcbuf = srcbuf.subarray(bodyindex) // skip header
    page.header = Object.assign(page.header, header)
    page.template = select_page_template(site, page)
    page.title = header.title
    page[BODY_LINE_OFFSET] = linecount
  } else if (srctype != "html") {
    // markdown and etc files without a front matter should always use a template
    page.template = site.defaultTemplate
  }

  if (!page.title)
    page.title = basename(path_without_ext(url).replace(/\/+$/, "")) || url

  return page
}


function select_page_template(site, page) {
  const template = page.header.template

  if (!template)
    return site.defaultTemplate

  const tryfiles = [
    ( template.indexOf(Path.sep) == -1 ? "_" + template :
      dirname(template) + "/_" + basename(template) ) + ".html",
    template + ".html",
    template,
  ]

  for (let fn of tryfiles) {
    fn = pathresolve(site.srcdir, fn)
    if (isfile(fn))
      return fn
  }

  log_important(
    `error: ${nicepath(page.srcfile)}:` +
    ` template file ${fmtjson(template)}` +
    ` not found in ${fmtjson(site.srcdir)}.` +
    ` (Tried ${tryfiles.join(", ")})` +
    ` Falling back to default template.`)

  return site.defaultTemplate
}


async function gen_page(site, page) {
  // build output filename
  const outfile = outfilename(site, page.srcfile, ".html")

  // skip generating outfile if it's up to date
  const isDynamic = site[DYNFILES].has(page.srcfile)
  if (!isDynamic) {
    const outfilemtime = mtime(outfile)
    if (page.srcmtime < outfilemtime && self_mtime < outfilemtime) {
      // also check its template
      const tplfilemtime = page.template ? mtime(page.template) : 0
      if (tplfilemtime < outfilemtime) {
        page.srcbuf = null // release memory
        return
      }
    }
  }

  // reset
  site[DYNFILES].set(page.srcfile, false)

  // render HTML
  const renderer = site.pageRenderers[page.srctype]
  let html = ""
  if (renderer) {
    html = renderer(site, page)
    if (page.template) {
      page.body = html
      const template_body = get_template(page.template)
      html = render_template(site, page, template_body, {
        filename: page.template,
        escape: html_encode,
      })
    }
  } else {
    html = page.srcbuf.toString("utf8")
  }

  page.srcbuf = null // release memory

  log(`${nicepath(page.srcfile)} -> ${nicepath(outfile)}`)
  return write_file(outfile, html)
}


function title_from_filename(filename) {
  let name = basename(filename, extname(filename))
  if (name.toLowerCase() == "index") {
    const dir = dirname(pathresolve(filename))
    if (dir == process.cwd()) {
      return ""
    }
    name = basename(dir)
  }
  return name.replace("_", " ")
}


function html_to_plain_text(html) {
  // 1. strip tags e.g. "<a href=...>hello</a>" -> "hello")
  // 2. decode entities e.g. "&amp;" => "&"
  // 3. normalize whitespace e.g. "foo   bar baz" => "foo bar baz"
  return html_decode(html.replace(/<[^>]+>/g, " ")).replace(/ {2,}/g, " ")
}


function render_page_md(site, page) {
  let mdsrc = page.srcbuf
  if (mdsrc.indexOf("{{") != -1)
    mdsrc = render_template(site, page, mdsrc.toString("utf8"), {filename: page.srcfile})
  return render_markdown(mdsrc)
}


function render_page_html(site, page) {
  return render_template(site, page, page.srcbuf.toString("utf8"), {
    filename: page.srcfile,
    escape: html_encode,
  })
}


function render_markdown(src) {
  return md.parse(src, {
    onCodeBlock(lang, body) {
      return syntax_highlight(lang, body)
    },
  })
}


function render_template(site, page, source, params) {
  // create js context for template
  // const wrap_helper = (fn) => function (...args) {
  //   return fn.call(page, ...args)
  // }
  const vmctx = {
    __proto__: page, // allow referencing page props directly
    site,
    page,
  }
  for (let name of Object.keys(site.templateHelpers)) {
    const v = site.templateHelpers[name]
    vmctx[name] = typeof v == "function" ? v.bind(vmctx) : v
  }
  vm.createContext(vmctx)

  const lineoffs = page[BODY_LINE_OFFSET] || 0
  let isDynamic = false

  const re = /(\\?|)\{\{(\!)?(.+?)\}\}/gsm
  const output = source.replace(re, (m, pre, bang, jsexpr, srcoffset) => {
    if (pre) {
      // skip escape'd block, e.g. "\{{...}}"
      return m.substr(1)
    }
    isDynamic = true
    let outbuf = []
    vmctx.print = function(...args) { outbuf.push(...args) }
    let value = vm_eval(vmctx, jsexpr, params.filename, source, srcoffset + 2, lineoffs)
    switch (typeof value) {
      case "object":
        value = value === null ? "null" : inspect(value, {
          breakLength: 80,
          maxStringLength: 60,
          depth: 4,
        })
        break
      default:
        value = value === undefined ? "" : String(value)
        break
    }
    if (outbuf.length > 0)
      value = outbuf.join("") + value
    if (bang || !params.escape)
      return value; // raw
    return params.escape(value)
  })

  site[DYNFILES].set(page.srcfile, isDynamic)

  return output
}


function get_template(filename) {
  let body = template_cache.get(filename)
  if (!body) {
    body = fs.readFileSync(filename, {encoding:"utf8"})
    template_cache.set(filename, body)
  }
  return body
}


async function gen_cssfiles(site, cssfiles) {
  const postcss_plugins = [
    require("postcss-nested"),
    require("postcss-import"),
  ]
  if (OPTIMIZE) {
    try {
      // these plugins are not bundled and loading them takes a really long time
      postcss_plugins.push(require("autoprefixer"))
      postcss_plugins.push(require('cssnano')({
        preset: ["default", {
          discardComments: {
            removeAll: true,
          },
        }]
      }))
    } catch (err) {
      console.error(`warning: ${err}`)
    }
  }
  const postcss = require("postcss")(postcss_plugins)
  return Promise.all(cssfiles.map(cssfile => gen_cssfile(site, cssfile, postcss)))
}


async function gen_cssfile(site, srcfile, postcss) {
  const outfile = outfilename(site, srcfile, ".css")
  const outfilemtime = mtime(outfile)
  const srcmtime = mtime_with_deps(site, srcfile)

  // skip generating outfile if it's up to date
  if (srcmtime < outfilemtime && self_mtime < outfilemtime)
    return

  // load file contents
  const src = await fsp.readFile(srcfile, {encoding:"utf8"})

  // process CSS
  log(`${nicepath(srcfile)} -> ${nicepath(outfile)}`)
  const result = await postcss.process(src, {
    from: srcfile,
    to: outfile,
    map: !OPTIMIZE,
  }).catch(err => {
    site[ERRCOUNT]++
    if (err.file && err.line !== undefined) {
      const file = relpath(site.srcdir, err.file)
      console.error(`error: ${file}:${err.line}:${err.column}: ${err.reason} (postcss)`)
    } else {
      console.error(`error: (postcss) ${err.stack||err}`)
    }
    return null
  })

  if (!result)
    return

  // write result
  const writepromise = write_file(outfile, result.css, {encoding:"utf8"})

  // memorize dependencies (TODO: only do this in watch mode)
  const depfiles = []
  for (let msg of result.messages) {
    if (msg.type == "dependency" && msg.plugin == "postcss-import") {
      depfiles.push(relpath(site.srcdir, msg.file))
      site[DEPFILES].add(msg.file)
    }
  }

  site[DEPS].set(srcfile, depfiles)

  return writepromise
}


function syntax_highlight(lang, bodybuf, errorReports, page) {
  if (lang == "") {
    // return hljs.highlightAuto(bodybuf.toString()).value
    return null // plain text
  }
  if (!hljs.getLanguage(lang)) {
    if (errorReports) {
      const errkey = page.srcfile + "/" + lang
      if (!errorReports.has(errkey)) {
        errorReports.add(errkey)
        // console.warn(
        //   `${page.srcfile}: Unknown code block language "${lang}"` +
        //   `; skipping syntax highlighting`)
      }
    }
    return null // plain text
  }
  let html = hljs.highlight(bodybuf.toString(), {language: lang}).value
  html = html.replace(/class="hljs-([^"]+)"/g, /class="hl-$1"/g)
  return html
}


function mkdirs(...dirnames) {
  // first, reduce the list of dir paths to only those needed for mkdirs.
  // E.g. with input:
  //   /a
  //   /a/b
  //   /a/c
  //   /a/c/d
  //   /a/c/d/e
  //   /a/c/f
  // we only call mkdirs for:
  //   /a/b
  //   /a/c/d/e
  //   /a/c/f
  const dirs = Array.from(new Set(dirnames)).sort()
  const promises = []
  for (let i = dirs.length; --i >= 0; ) {
    if (!String(dirs[i + 1]).startsWith(dirs[i] + Path.sep)) {
      promises.push(fsp.mkdir(dirs[i], {recursive: true}))
    }
  }
  return Promise.all(promises)
}


async function copy_files_to_dir(site, srcfiles, dstdir) {
  const outfiles = srcfiles.map(srcfile => outfilename(site, srcfile))
  const outdirs = outfiles.map(fn => dirname(fn))
  await mkdirs(...outdirs)
  return Promise.all(srcfiles.map((srcfile, i) =>
    copy_file(srcfile, outfiles[i]) ))
}


function copy_file(srcfile, dstfile) {
  return new Promise((resolve, reject) => {
    if (mtime(srcfile) < mtime(dstfile))
      return resolve()
    log(`${nicepath(srcfile)} -> ${nicepath(dstfile)}`)
    const fl = fs.constants.COPYFILE_FICLONE  // copy-on-write if FS supports it
    return fs.copyFile(srcfile, dstfile, fl, err => {
      if (!err)
        return resolve()
      if (err.code != "ENOENT")
        return reject(wrap_error(err))
      // attempt to create directories and then copyFile again
      console.error("** try mkdir", dirname(dstfile))
      try {
        fs.mkdirSync(dirname(dstfile), {recursive: true})
      } catch (err) {
        return reject(wrap_error(err))
      }
      fs.copyFile(srcfile, dstfile, fl, err => {
        err ? reject(wrap_error(err)) : resolve()
      })
    })
  })
}


function find_files(dir, filterfn) { // -> Promise<string[]>
  return new Promise(resolve => {
    const files = []
    let nactive = 0 // number of active visitors
    async function visit_dir(dir) {
      const d = await fsp.opendir(dir, { bufferSize: 128 })
      for await (const ent of d) {
        ent.path = pathjoin(dir, ent.name)
        if (!filterfn || filterfn(ent)) {
          if (ent.isFile() || ent.isSymbolicLink()) {
            files.push(ent.path)
          } else if (ent.isDirectory()) {
            nactive++
            visit_dir(ent.path, filterfn)
          }
        }
      }
      nactive--
      if (nactive == 0)
        resolve(files)
    }
    nactive++
    visit_dir(dir)
  })
}


function mtime(filename) {
  try {
    return fs.statSync(filename).mtimeMs
  } catch (err) {
    if (err.code == "ENOENT")
      return 0
    throw err
  }
}


function isfile(filename) {
  try {
    return fs.statSync(filename).isFile()
  } catch (err) {
    return false
  }
}


function mtime_with_deps(site, filename) {
  return Math.max(mtime(filename), ...(site[DEPS].get(filename) || []).map(mtime))
}


function html_encode(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[tag]))
}


function html_decode(str) {
  return str.replace(/&([A-Za-z0-9#]+);/g, (match, code) => {
    if (code[0] == '#') {
      const charcode = parseInt(code.substr(1), 16)
      return isNaN(charcode) ? match : String.fromCharCode(charcode)
    }
    return {
      'amp': '&',
      'lt': '<',
      'gt': '>',
      'quot': '"',
    }[code] || match
  })
}


function vm_eval(vmctx, jsexpr, filename, srctext, srcoffset, lineoffs) {
  try {
    return vm.runInContext(jsexpr, vmctx, {
      displayErrors: false,
    })
  } catch (err) {
    // show error
    let pos = find_src_pos(srctext, srcoffset)
    pos.line += lineoffs
    try {
      vm.runInContext(jsexpr, vmctx, {
        lineOffset: pos.line - 1,
        columnOffset: pos.col - 1,
        filename: filename,
      })
      console.error(`${filename}:${pos.line}:${pos.col}: unknown error`)
    } catch (err) {
      const detail = err.stack.split("\n\n")[0].split("\n").slice(1).join("\n")
      console.error(`${nicepath(filename)}:${pos.line}:${pos.col}: ${err.message}\n${detail}`)
    }
    return undefined
  }
}


function find_src_pos(text, offset) {
  let col = 1
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (text[i] == "\n") {
      line++
      col = 1
    } else {
      col++
    }
  }
  return {line, col}
}


function parse_md_header(buf, filename) {
  let header = {}
  if (!(buf instanceof Buffer))
    buf = Buffer.from(buf)
  let starti = endof_md_header_line(buf)
  let endi = buf.indexOf(buf_lf_dash_x3, starti)
  let bodyindex = 0
  if (endi >= 0) {
    bodyindex = endof_md_header_line(buf, endi + 1)
    if (bodyindex == -1)
      bodyindex = 0
  }
  let linecount = 0
  if (starti >= 0 && endi >= 0 && bodyindex > 0) {
    let text = buf.subarray(starti, endi).toString("utf8")
    let lines = text.trim().split(/\s*\n\s*/)
    linecount = lines.length + 2 // + "---" x 2
    for (let key of lines) {
      let i = key.indexOf(":")
      let value = null
      if (i >= 0) {
        value = key.substr(i + 1).trim()
        key   = key.substr(0, i).trim()
      } else {
        key = key.trim()
      }
      header[key.toLowerCase()] = value
    }
  }
  return { header, bodyindex, linecount }
}


function endof_md_header_line(buf, startindex) {
  let ndashes = 0
  let i = startindex || 0
  loop:
  for (; i < buf.length; i++) {
    switch (buf[i]) {
      case 0x0A: // "\n"
        break loop
      case 0x09: case 0x20: // " ", "\t"
        break
      case 0x2D: // "-"
        ndashes++
        break
      default:
        break loop
    }
  }
  if (ndashes < 3)
    return -1
  return i + 1
}


async function write_file(filename, body, options) {
  let did_retry = false
  while (1) {
    try {
      await fsp.writeFile(filename, body, options)
    } catch (err) {
      if (!did_retry && err.code == "ENOENT") {
        did_retry = true
        const dir = dirname(filename)
        fs.mkdirSync(dir, {recursive: true})
        continue
      }
      throw wrap_error(err)
    }
    break
  }
}


function wrap_error(err) {
  if ((err.stack || "").indexOf("\n") != -1)
    return err
  return new Error(err.stack || String(err))
}


function outfilename(site, srcpath, ext) {
  let relname = relpath(site.srcdir, srcpath)
  if (ext)
    relname = path_without_ext(relname) + ext
  return pathjoin(site.outdir, relname)
}


function path_without_ext(filename) {
  return filename.substr(0, filename.length - extname(filename).length)
}


function nicepath(path) {
  return relpath(process.cwd(), path) || "."
}


main(process.argv.slice(2))
  .then((exitCode) => process.exit(exitCode || 0))
  .catch(err => {
    console.error(err.stack || String(err))
    process.exit(1)
  })
