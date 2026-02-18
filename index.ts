#!/usr/bin/env -S node --experimental-transform-types

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type HTMLElement, parse } from 'node-html-parser';

const DEFAULT_SOURCE_DIR = '../PlaceCal/app/assets/images/icons/';
/** viewbox */
const TARGET_SIZE = 24;
/** after scaling */
const MAX_DECIMALS = 3;
/** when joining params array back into a string */
const PARAM_JOINER = ',';
/** all SVG shape tags */
// https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorials/SVG_from_scratch/Basic_shapes
const SHAPE_TAGS = ['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon'] as const;

/** SVG path command, boolean[] of which params should be scaled. length implies param count. this is not exhaustive */
// each has an upper (absolute) and lower (relative) variant, though it doesn't matter for our case
// https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/d
// TODO: maybe refactor as arrays of 'x'|'y'|false and update `scaleParam` to handle viewbox quirks
const PATH_COMMAND_MAPPERS = new Map<string, boolean[]>([
  ['a', [true, true, false, false, false, true, true]],
  ['c', [true, true, true, true, true, true]],
  ['h', [true]],
  ['l', [true, true]],
  ['m', [true, true]],
  ['t', [true, true]],
  ['q', [true, true, true, true]],
  ['s', [true, true, true, true]],
  ['v', [true]],
  ['z', []],
]);

/** hex colours to css classes */
const COLOUR_CLASSES = new Map<string, string>([
  ['#5b4e46', 'text-placecal-brown'],
  ['#fffcf0', 'text-base-background'],
  ['#fffbef', 'text-home-background'],
  ['#afcf5a', 'text-base-primary'],
  ['#f19089', 'text-base-secondary'],
]);

/** file to icon renames */
const RENAMES = new Map<string, string>([
  // form
  ['ticked', 'checkbox_check'],
  ['unticked', 'checkbox'],
  ['selected', 'radio_check'],
  ['unselected', 'radio'],

  // misc
  // menu redo
  ['menu2', 'menu'],
]);

/** files which are unused and cannot be trivially fixed */
const SKIPS = [
  // non-square viewbox, css transforms, trivial shape. quicker to rewrite
  '../PlaceCal/app/assets/images/icons/arrow/right.svg',
  '../PlaceCal/app/assets/images/icons/arrow/left.svg',
  '../PlaceCal/app/assets/images/icons/arrow/down.svg',
  '../PlaceCal/app/assets/images/icons/arrow/right-grey.svg',
  '../PlaceCal/app/assets/images/icons/arrow/left-grey.svg',
  // lots of garbage, offsets. seems to be unused so skipping for now
  '../PlaceCal/app/assets/images/icons/instagram-circle.svg',
  // non-square viewbox, trivial shape. quicker to rewrite
  '../PlaceCal/app/assets/images/icons/menu.svg',
  // non-square viewbox. skipping for now
  '../PlaceCal/app/assets/images/icons/place.svg',
  // non-square viewbox. skipping for now
  '../PlaceCal/app/assets/images/icons/question-mark.svg',
  // non-square viewbox. skipping for now
  '../PlaceCal/app/assets/images/icons/repeats.svg',
  // exponent-formatted numbers. skipping for now
  '../PlaceCal/app/assets/images/icons/roundel.svg',
]

function getNumberAttrib(elem: HTMLElement, attrib: string): number {
  const value = elem.getAttribute(attrib);
  if (typeof value !== 'string')
    throw new Error(`attrib ${attrib} does not exist on ${elem.tagName.toLocaleLowerCase()}`);
  return parseFloat(value);
}

function scaleParam(param: number, viewBox: { w: number }): number {
  return parseFloat(((param / viewBox.w) * TARGET_SIZE).toFixed(MAX_DECIMALS));
}

function getViewBox(svg:HTMLElement):{x:number,y:number,w:number,h:number} {
    const viewBoxString = svg.getAttribute('viewbox');
    if (!viewBoxString) throw new Error('no viewbox found on svg elem');
    const [x, y, w, h] = viewBoxString.split(/\s+/).map(parseFloat);
    console.debug({x,y,w,h})
    // tolerate slight w,h difference
    if (Math.abs(w-h)>Math.max(w,h)*.01) throw new Error('viewbox is not square');
    if (x !== 0 || y !== 0) throw new Error('viewbox has non-zero offset');
    return { x, y, w: Math.max(w,h), h:Math.max(w,h) };
}

const sourceDir = process.argv.at(2) ?? DEFAULT_SOURCE_DIR;

const files = (await readdir(sourceDir, { recursive: false, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.svg') )
  .map(({ name, parentPath }) => {
    const baseName = name.replace(/\.svg$/i, '');
    return {
      parentPath,
      filePath: join(parentPath, name),
      iconName: RENAMES.get(baseName) ?? baseName,
    };
  })
  .filter(({filePath})=>!SKIPS.includes(filePath))
  .toSorted((a, b) => a.parentPath.localeCompare(b.parentPath) || a.iconName.localeCompare(b.iconName));

function parseParams(text:string|undefined):number[] {
  if (typeof text==='undefined') throw new Error('params string is undefined');
  // params are usually split by whitespace or `,`, but the leading `-` of a negative or a second decimal `.` is also valid
  return [...text.matchAll(/(-?\d*\.?\d*)/g)]
              .map(match=>match[0])
              .filter(token=>token.length)
              .map(parseFloat)
}

for (const { filePath, iconName } of files) {
  try {
    const contents = await readFile(filePath, { encoding: 'utf-8' });
    const dom = parse(contents);
    const svg = dom.querySelector('svg');
    if (!svg) throw new Error('no svg elem found');
    const viewBox = getViewBox(svg)

    // per-elem paths in case an icon should be split into multiple. they're safe to concat if not, since we throw if a path starts with a relative command
    const remappedPaths: string[][] = [];

    for (const shapeTag of SHAPE_TAGS) {
      const elems = dom.querySelectorAll(shapeTag);
      for (const elem of elems) {
        const remappedPath: string[] = [];

        if (shapeTag === 'path') {
          const path = elem.getAttribute('d');
          if (!path) throw new Error('path elem has no d attrib');

          const commandMatches = [...path.matchAll(/(?<command>[a-zA-Z])(?<params>[0-9., -]*)/g)];
          for (const [c, commandMatch] of commandMatches.entries()) {
            const command = commandMatch.groups?.command;
            if (!command) throw new Error(`could not parse command from ${commandMatch[0]}`);
            // TODO: if there are any, these will be annoying to fix
            if (c === 0 && remappedPath.length && command.toLocaleUpperCase() !== command)
              throw new Error(`path begins with a relative command ${path}`);

            const params=parseParams(commandMatch.groups?.params)

            const mapper = PATH_COMMAND_MAPPERS.get(command.toLocaleLowerCase());
            if (!mapper) throw new Error(`unhandled command ${command}`);
            // need to mod because it's valid to give multiples of params to imply multiples of command
            if (mapper.length && params.length % mapper.length !== 0)
              throw new Error(
                `unexpected ${command} param count ${params.join(', ')}. params.length: ${params.length} mapper.length: ${mapper.length}`
              );
            remappedPath.push(
              `${command}${params
                .map((param, i) => (mapper[i % mapper.length] ? scaleParam(param, viewBox) : param))
                .join(PARAM_JOINER)}`
            );
          }
        } else if (shapeTag === 'circle') {
          const [cx, cy, r] = [
            getNumberAttrib(elem, 'cx'),
            getNumberAttrib(elem, 'cy'),
            getNumberAttrib(elem, 'r'),
          ].map((param) => scaleParam(param, viewBox));
          remappedPath.push(
            `M${[cx, cy - r].join(PARAM_JOINER)}`,
            `A${[r, r, 0, 1, 0, cx + 0.001, cy - r].join(PARAM_JOINER)}`,
            'Z',
          );
        } else if (shapeTag==='polygon') {
          const points=parseParams(elem.getAttribute('points')).map((param)=>scaleParam(param,viewBox))
          if (points.length<4 || points.length%2!==0) throw new Error(`unexpected points length ${points.length}`)
          const [sx,sy]=[points.shift(),points.shift()]
          remappedPath.push(
            `M${[sx,sy].join(PARAM_JOINER)}`,
            `L${points.join(PARAM_JOINER)}`,
            'Z',
          )
        }
        else throw new Error(`unhandled shape tag ${shapeTag}`);

        remappedPaths.push(remappedPath);
      }
    }

    const paths = remappedPaths.map((path) => path.join(' '));
    const colours = [...contents.matchAll(/#[0-9a-fA-F]{3,}/gi)].map((match) => match[0].toLocaleLowerCase());
    const classes = colours.map((colour) => COLOUR_CLASSES.get(colour) ?? colour);

    console.log({ iconName, paths, classes, concat: paths.length>1 ? paths.join(' ') : null });
  } catch (err) {
    console.error('error parsing', filePath, err);
    throw err;
  }
}
