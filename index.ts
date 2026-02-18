#!/usr/bin/env -S node --experimental-transform-types

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type HTMLElement, parse } from 'node-html-parser';

// min is used for scaling <circle/> radius
type ScaleAxis = 'x' | 'y' | 'min' | false;

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

/** SVG path command, ScaleAxis[] of which params should be scaled. length implies param count. this is not necessarily exhaustive */
// each has an upper (absolute) and lower (relative) variant, though it doesn't matter for our case
// https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/d
const PATH_COMMAND_MAPPERS = new Map<string, ScaleAxis[]>([
  ['a', ['x', 'y', false, false, false, 'x', 'y']],
  ['c', ['x', 'y', 'x', 'y', 'x', 'y']],
  ['h', ['x']],
  ['l', ['x', 'y']],
  ['m', ['x', 'y']],
  ['t', ['x', 'y']],
  ['q', ['x', 'y', 'x', 'y']],
  ['s', ['x', 'y', 'x', 'y']],
  ['v', ['y']],
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

/** files to skip */
const SKIPS = [
  // rewritten
  '../PlaceCal/app/assets/images/icons/arrow/right.svg',
  '../PlaceCal/app/assets/images/icons/arrow/left.svg',
  '../PlaceCal/app/assets/images/icons/arrow/down.svg',
  '../PlaceCal/app/assets/images/icons/arrow/right-grey.svg',
  '../PlaceCal/app/assets/images/icons/arrow/left-grey.svg',
  '../PlaceCal/app/assets/images/icons/menu.svg',
];

function getNumberAttrib(elem: HTMLElement, attrib: string): number {
  const value = elem.getAttribute(attrib);
  if (typeof value !== 'string')
    throw new Error(`attrib ${attrib} does not exist on ${elem.tagName.toLocaleLowerCase()}`);
  return parseFloat(value);
}

function getViewBox(svg: HTMLElement): { x: number; y: number; w: number; h: number } {
  const viewBoxString = svg.getAttribute('viewbox');
  if (!viewBoxString) throw new Error('no viewbox found on svg elem');
  const [x, y, w, h] = viewBoxString.split(/\s+/).map(parseFloat);
  const result = { x, y, w, h };
  console.debug(result);
  return result;
}

function scaleParam(param: number, axis: ScaleAxis, viewBox: ReturnType<typeof getViewBox>): number {
  if (!axis) return param;
  const [shortest, longest] = [viewBox.w, viewBox.h].toSorted((a, b) => a - b);
  const axisLength = axis === 'x' ? viewBox.w : axis === 'y' ? viewBox.h : 0;
  const axisOffset = axis === 'min' ? 0 : viewBox[axis];
  // preserve proportions
  const scaled = (param / longest) * TARGET_SIZE;
  // min axis is only used for circle radius and has no offset or shift
  // subtract source viewbox offset so final viewbox offset is 0
  const offset = (axisOffset / longest) * TARGET_SIZE;
  // shift to center non-square source viewbox in a square
  const shift = axisLength === 0 || axisLength === longest ? 0 : (((longest - shortest) / longest) * TARGET_SIZE) / 2;
  console.debug({ axis, axisLength, shortest, longest, param, scaled, offset, shift });
  return parseFloat((scaled - offset + shift).toFixed(MAX_DECIMALS));
}

function parseParams(text: string | undefined): number[] {
  if (typeof text === 'undefined') throw new Error('params string is undefined');
  // params are usually split by whitespace or `,`, but the leading `-` of a negative or a second decimal `.` is also valid. they may also have an exponent
  return [...text.matchAll(/(-?\d*\.?\d*(?:e-?\d+)?)/g)]
    .map((match) => match[0])
    .filter((token) => token.length)
    .map(parseFloat);
}

async function processFile(filePath: string) {
  if (SKIPS.includes(filePath)) return;
  const base = basename(filePath).replace(/\.svg$/i, '');
  const iconName = RENAMES.get(base) ?? base.replaceAll('-', '_');
  try {
    const contents = await readFile(filePath, { encoding: 'utf-8' });
    const dom = parse(contents);
    const svg = dom.querySelector('svg');
    if (!svg) throw new Error('no svg elem found');
    const viewBox = getViewBox(svg);

    // per-elem paths in case an icon should be split into multiple. they're safe to concat if not, since we throw if a path starts with a relative command
    const remappedPaths: string[][] = [];

    for (const shapeTag of SHAPE_TAGS) {
      const elems = dom.querySelectorAll(shapeTag);
      for (const elem of elems) {
        const remappedPath: string[] = [];

        if (shapeTag === 'path') {
          const path = elem.getAttribute('d');
          if (!path) throw new Error('path elem has no d attrib');

          // whitespace before a command is not required. sometimes params can have exponents
          const commandMatches = [...path.matchAll(/(?<command>[a-df-zA-Z])(?<params>[0-9., e-]*)/g)];
          for (const [c, commandMatch] of commandMatches.entries()) {
            const command = commandMatch.groups?.command;
            if (!command) throw new Error(`could not parse command from ${commandMatch[0]}`);
            if (c === 0 && remappedPath.length && command.toLocaleUpperCase() !== command)
              throw new Error(`path begins with a relative command ${path}`);

            const params = parseParams(commandMatch.groups?.params);

            const mapper = PATH_COMMAND_MAPPERS.get(command.toLocaleLowerCase());
            if (!mapper) throw new Error(`unhandled command ${command}`);
            // need to mod because it's valid to give multiples of params to imply multiples of command
            if (mapper.length && params.length % mapper.length !== 0)
              throw new Error(
                `unexpected ${command} param count ${params.join(', ')} (orig ${commandMatch.groups?.params}). params.length: ${params.length} mapper.length: ${mapper.length}`
              );
            remappedPath.push(
              `${command}${params
                .map((param, i) => scaleParam(param, mapper[i % mapper.length], viewBox))
                .join(PARAM_JOINER)}`
            );
          }
        } else if (shapeTag === 'circle') {
          const [cx, cy, r] = [
            getNumberAttrib(elem, 'cx'),
            getNumberAttrib(elem, 'cy'),
            getNumberAttrib(elem, 'r'),
          ].map((param, i) => scaleParam(param, i === 0 ? 'x' : i === 1 ? 'y' : 'min', viewBox));
          remappedPath.push(
            `M${[cx, cy - r].join(PARAM_JOINER)}`,
            `A${[r, r, 0, 1, 0, cx + 0.001, cy - r].join(PARAM_JOINER)}`,
            'Z'
          );
        } else if (shapeTag === 'polygon') {
          const points = parseParams(elem.getAttribute('points')).map((param, i) =>
            scaleParam(param, i % 2 ? 'y' : 'x', viewBox)
          );
          if (points.length < 4 || points.length % 2 !== 0)
            throw new Error(`unexpected points length ${points.length}`);
          const [sx, sy] = [points.shift(), points.shift()];
          remappedPath.push(`M${[sx, sy].join(PARAM_JOINER)}`, `L${points.join(PARAM_JOINER)}`, 'Z');
        } else throw new Error(`unhandled shape tag ${shapeTag}`);

        remappedPaths.push(remappedPath);
      }
    }

    const paths = remappedPaths.map((path) => path.join(' '));
    const colours = [...contents.matchAll(/#[0-9a-fA-F]{3,}/gi)].map((match) => match[0].toLocaleLowerCase());
    const classes = colours.map((colour) => COLOUR_CLASSES.get(colour) ?? colour);
    const concat = paths.length > 1 ? paths.join(' ') : null;

    console.debug(viewBox);
    console.log({ iconName, paths, classes, concat });
  } catch (err) {
    console.error('error parsing', filePath, err);
    throw err;
  }
}

const sourcePath = process.argv.at(2) ?? DEFAULT_SOURCE_DIR;

if ((await stat(sourcePath)).isFile()) processFile(sourcePath);
else {
  const filePaths = (await readdir(sourcePath, { recursive: false, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.svg'))
    .map(({ name, parentPath }) => join(parentPath, name))
    .toSorted();
  for (const filePath of filePaths) await processFile(filePath);
}
