'use strict'

const autoprefixer = require('autoprefixer')
const browserify = require('browserify')
const babelify = require('babelify')
const buffer = require('vinyl-buffer')
const concat = require('gulp-concat')
const cssnano = require('cssnano')
const fs = require('fs-extra')
const imagemin = require('gulp-imagemin')
const { obj: map } = require('through2')
const merge = require('merge-stream')
const ospath = require('path')
const path = ospath.posix
const postcss = require('gulp-postcss')
const postcssCalc = require('postcss-calc')
const postcssImport = require('postcss-import')
const postcssUrl = require('postcss-url')
const postcssVar = require('postcss-custom-properties')
const uglify = require('gulp-uglify')
const vfs = require('vinyl-fs')

module.exports = (src, dest, preview) => () => {
  const opts = { base: src, cwd: src }
  const sourcemaps = preview || process.env.SOURCEMAPS === 'true'
  const postcssPlugins = [
    postcssImport,
    (root, { messages, opts: { file } }) =>
      Promise.all(
        messages
          .reduce((accum, { file: depPath, type }) => (type === 'dependency' ? accum.concat(depPath) : accum), [])
          .map((importedPath) => fs.stat(importedPath).then(({ mtime }) => mtime))
      ).then((mtimes) => {
        const newestMtime = mtimes.reduce((max, curr) => (!max || curr > max ? curr : max))
        if (newestMtime > file.stat.mtime) file.stat.mtimeMs = +(file.stat.mtime = newestMtime)
      }),
    postcssUrl([
      {
        filter: '**/~typeface-*/files/*',
        url: (asset) => {
          const relpath = asset.pathname.substr(1)
          const abspath = require.resolve(relpath)
          const basename = ospath.basename(abspath)
          const destpath = ospath.join(dest, 'font', basename)
          if (!fs.pathExistsSync(destpath)) fs.copySync(abspath, destpath)
          return path.join('..', 'font', basename)
        },
      },
    ]),
    postcssVar({ preserve: preview ? 'preserve-computed' : false }),
    preview ? postcssCalc : () => {},
    autoprefixer,
    preview ? () => {} : cssnano({ preset: 'default' }),
  ]

  return merge(
    vfs
      .src('js/+([0-9])-*.js', { ...opts, sourcemaps })
      .pipe(uglify())
      // NOTE concat already uses stat from newest combined file
      .pipe(concat('js/site.js')),
    vfs
      .src('js/vendor/*.js', { ...opts, read: false })
      .pipe(
        // see https://gulpjs.org/recipes/browserify-multiple-destination.html
        map((file, enc, next) => {
          if (file.relative.endsWith('.bundle.js')) {
            const mtimePromises = []
            const bundlePath = file.path
            browserify(file.relative, { basedir: src, detectGlobals: false })
              .plugin('browser-pack-flat/plugin')
              .transform(babelify.configure({
                presets: ['@babel/preset-env'],
              }))
              .on('file', (bundledPath) => {
                if (bundledPath !== bundlePath) mtimePromises.push(fs.stat(bundledPath).then(({ mtime }) => mtime))
              })
              .bundle((bundleError, bundleBuffer) => {
                if (bundleError) {
                  next(bundleError, file)
                } else {
                  Promise.all(mtimePromises).then((mtimes) => {
                    if (mtimes.length > 0) {
                      const newestMtime = mtimes.reduce((max, curr) => (!max || curr > max ? curr : max))
                      if (newestMtime > file.stat.mtime) file.stat.mtimeMs = +(file.stat.mtime = newestMtime)
                    }
                    file.contents = bundleBuffer
                    file.path = file.path.slice(0, file.path.length - 10) + '.js'
                    next(bundleError, file)
                  })
                }
              })
          } else {
            fs.readFile(file.path, 'UTF-8').then((contents) => {
              file.contents = Buffer.from(contents)
              next(null, file)
            })
          }
        })
      )
      .pipe(buffer())
      .pipe(uglify()),
    vfs
      .src('css/site.css', { ...opts, sourcemaps })
      .pipe(postcss((file) => ({ plugins: postcssPlugins, options: { file } }))),
    vfs.src('font/*.{ttf,woff*(2)}', opts),
    vfs
      .src('img/**/*.{gif,ico,jpg,png,svg}', opts)
      .pipe(
        imagemin(
          [
            imagemin.gifsicle(),
            imagemin.jpegtran(),
            imagemin.optipng(),
            imagemin.svgo({ plugins: [{ removeViewBox: false }] }),
          ].reduce((accum, it) => (it ? accum.concat(it) : accum), [])
        )
      ),
    vfs.src('helpers/*.js', opts),
    vfs.src('layouts/*.hbs', opts),
    vfs.src('partials/*.hbs', opts)
  ).pipe(vfs.dest(dest, { sourcemaps: sourcemaps && '.' }))
}
