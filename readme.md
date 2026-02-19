Helper util for converting raw SVGs to paths for [PlaceCal](https://github.com/geeksforsocialchange/PlaceCal) `SvgIconsHelper`. Non-path shapes are converted to paths and viewboxes are normalised to 24x24.

## Requirements
- `nvm`
- `pnpm`

## Setup
```bash
nvm use
pnpm install
```

## Usage
`pnpm start [optional path arg]`

`[optional path arg]` can be either a file or a directory. Only top-level files from the directory are processed to keep the output more manageable

Some files (e.g. `../PlaceCal/app/assets/images/icons/instagram.svg`) contain garbage which needs to be temporarily deleted to not throw off parsing

I am not parsing embedded CSS or other places where `fill` and `stroke` settings may be configured. You need to look at the source for this info.

If a file contains multiple shape elements, a `concat` field will be output in addition to the individual paths. You are safe to use this as the `path`, providing that colour, fill, and stroke are the same for each.

Colour classes are intended to be used at point-of-use rather than in `SvgIconsHelper`. Use `currentColor` and `none` to configure `fill` and `stroke` appropriately.