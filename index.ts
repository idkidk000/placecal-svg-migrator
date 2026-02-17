#!/usr/bin/env -S node --experimental-transform-types

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'node-html-parser';

const DEFAULT_SOURCE_DIR = '../PlaceCal/app/assets/images/icons/forms';
/** viewbox */
const TARGET_SIZE = 24;
/** after scaling */
const MAX_DECIMALS = 3;
/** when joining params array back into a string */
const PARAM_JOINER = ',';
/** all SVG shape tags */
// https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorials/SVG_from_scratch/Basic_shapes
const SHAPE_TAGS = ['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon'] as const;

/** SVG path param, boolean[] of which params should be scaled. length implies param count */
// each has an upper (absolute) and lower (relative) variant, though it doesn't matter for our case
// https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/d
const PATH_COMMAND_MAPPERS = new Map<string, boolean[]>([
  ['a', [true, true, false, false, false, true, true]],
  ['h', [true]],
  ['l', [true, true]],
  ['m', [true, true]],
  ['t', [true, true]],
  ['q', [true, true, true, true]],
  ['v', [true]],
  ['z',[]]
]);

const COLOUR_CLASSES = new Map<string, string>([
  ['#5b4e46', 'text-placecal-brown'],
  ['#fffcf0', 'text-base-background'],
  ['#fffbef', 'text-home-background'],
]);

const RENAMES = new Map<string,string>([
  ['ticked','checkbox_check'],
  ['unticked','checkbox'],
  ['selected','radio_check'],
  ['unselected','radio'],
])

const sourceDir = process.argv.at(2) ?? DEFAULT_SOURCE_DIR;

const files = (await readdir(sourceDir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.svg'))
  .map(({ name, parentPath }) => {
    const baseName = name.replace(/\.svg$/,'')
    return {
      parentPath,
      filePath: join(parentPath,name),
      iconName: RENAMES.get(baseName) ?? baseName
    }
  })
  .toSorted((a,b)=>a.parentPath.localeCompare(b.parentPath) || a.iconName.localeCompare(b.iconName))

for (const { filePath, iconName } of files) {
  try {
    const contents = await readFile(filePath, { encoding: 'utf-8' });
    const dom = parse(contents);
    const svg = dom.querySelector('svg');
    if (!svg) throw new Error('no svg elem found');

    const viewboxString = svg.getAttribute('viewbox');
    if (!viewboxString) throw new Error('no viewbox found on svg elem');
    const [x, y, w, h] = viewboxString.split(/\s+/).map(parseFloat);
    // console.debug(name, { x, y, w, h });
    // TODO: handle later
    if (w !== h) throw new Error('viewbox is not square');
    if (x !== 0 || y !== 0) throw new Error('viewbox has non-zero offset');
    const viewbox = { x, y, w, h };

    // per-elem paths in case an icon should be split into multiple. they're safe to concat if not, since we throw if a path starts with a relative command
    const remappedPaths: string[][] = [];

    for (const shapeTag of SHAPE_TAGS) {
      const elems = dom.querySelectorAll(shapeTag);
      for (const elem of elems) {
        const remappedPath: string[] = [];

        if (shapeTag === 'path') {
          const path = elem.getAttribute('d');
          if (!path) throw new Error('path elem has no d attrib');

          const commandMatches = [...path.matchAll(/(?<command>[a-zA-Z])(?<params>[0-9., -]*)+/g)];
          for (const [c, commandMatch] of commandMatches.entries()) {
            const command = commandMatch.groups?.command;
            if (!command) throw new Error(`could not parse command from ${commandMatch[0]}`);
            // TODO: if there are any, these will be annoying to fix
            if (c === 0 && remappedPath.length && command.toLocaleUpperCase() !== command)
              throw new Error(`path begins with a relative command ${path}`);
            const paramsString = commandMatch.groups?.params;
            // Z (close path) has no params
            if (typeof paramsString==='undefined') throw new Error(`could not parse params from ${commandMatch[0]}`);

            // params are usually split by whitespace or ',', but the leading '-' of a negative is also valid
            const params = [...paramsString.matchAll(/(-?[0-9.]+)/g)].map((match) => parseFloat(match[0]));
            // console.debug({ command, params });

            const mapper = PATH_COMMAND_MAPPERS.get(command.toLocaleLowerCase());
            if (!mapper) throw new Error(`unhandled command ${command}`);
            // need to mod because it's valid to give multiples of params to imply multiple commands of the same type
            if (mapper.length && (params.length % mapper.length !== 0))
              throw new Error(`unexpected ${command} param count ${params.join(', ')}. params.length: ${params.length} mapper.length: ${mapper.length}`);
            remappedPath.push(
              `${command}${params
                .map((param, i) => {
                  if (mapper[i % mapper.length])
                    return parseFloat(((param / viewbox.w) * TARGET_SIZE).toFixed(MAX_DECIMALS));
                  return param;
                })
                .join(PARAM_JOINER)}`
            );
          }
        } else if (shapeTag === 'circle') {
          const [cx, cy, r] = [elem.getAttribute('cx'), elem.getAttribute('cy'), elem.getAttribute('r')];
          if ([cx, cy, r].some((param) => typeof param === 'undefined'))
            throw new Error('circle is missing required attribs');
          const [scaledCx, scaledCy, scaledR] = [cx, cy, r].map((param) =>
            // biome-ignore lint/style/noNonNullAssertion: i checked ^^^ but lazily
            parseFloat(((parseFloat(param!) / viewbox.w) * TARGET_SIZE).toFixed(MAX_DECIMALS))
          );
          // TODO: i think this is correct - verify
          remappedPath.push(
            `M${[scaledCx, scaledCy - scaledR].join(PARAM_JOINER)}`,
            `A${[scaledR, scaledR, 0, 1, 0, scaledCx+0.001, scaledCy - scaledR].join(PARAM_JOINER)}`
          );
        } else throw new Error(`unhandled shape tag ${shapeTag}`);

        remappedPaths.push(remappedPath);
      }
    }

    const paths = remappedPaths.map((path) => path.join(' '));
    const colours = [...contents.matchAll(/#[0-9a-fA-F]{3,}/g)].map((match) => match[0]);
    const classes = colours.map((colour) => COLOUR_CLASSES.get(colour) ?? colour);

    console.log({ iconName, paths, classes });
  } catch (err) {
    console.error('error parsing', filePath, err);
    throw err;
  }
}
