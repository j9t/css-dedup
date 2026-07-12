// The CSS named colors (CSS Color Module Level 4), mapped to their six-digit hex
// equivalents. Used only to canonicalize a value for comparison—output always
// keeps a spelling that already exists in the source, so CSS Dedup never rewrites
// `white` to `#ffffff` (or vice versa) on its own.
const NAMED_COLORS = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4',
  azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000',
  blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a',
  burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00', chocolate: 'd2691e',
  coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b',
  darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc',
  darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b',
  darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
  deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969',
  dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22',
  fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700',
  goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f',
  grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
  indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa',
  lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3',
  lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1', lightsalmon: 'ffa07a',
  lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32',
  linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa',
  mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585',
  midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
  navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
  papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb',
  plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
  red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513',
  salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee',
  sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
  slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f',
  steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8',
  tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3',
  white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
};

const RE_NAMED_COLOR = new RegExp(`\\b(?:${Object.keys(NAMED_COLORS).join('|')})\\b`, 'g');

const RE_HEX_COLOR = /#([0-9a-f]+)\b/g;

// `rgb()`/`rgba()` with no nested function call inside—`[^()]*` deliberately
// refuses to match once a `calc()` or `var()` (already a placeholder by the
// time this runs, but its parentheses remain) shows up in the arguments,
// leaving those values alone
const RE_RGB_FUNCTION = /\brgba?\(([^()]*)\)/g;

// Same shape as `RE_RGB_FUNCTION`—only consulted in aggressive mode,
// since `hsl()` equivalence goes through rounding (see `canonicalizeHsl()`)
const RE_HSL_FUNCTION = /\bhsla?\(([^()]*)\)/g;

// A plain 0–255 integer channel (the only form safe mode canonicalizes)
const RE_INTEGER_CHANNEL = /^\d{1,3}$/;

// A hue (a number with an optional angle unit)
const RE_HUE = /^(-?[\d.]+)(deg|grad|rad|turn)?$/;

// `#abc` → `#aabbcc`, `#abcd` → `#aabbccdd`; a fully opaque alpha channel is
// the default, so `…ff` is dropped from an eight-digit form
function expandHex(hex) {
  const digits = hex.length <= 4 ? Array.from(hex, digit => digit + digit).join('') : hex;
  return digits.length === 8 && digits.endsWith('ff') ? digits.slice(0, 6) : digits;
}

function parseAlpha(raw) {
  const number = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0), 1);
}

// One canonical spelling for a set of resolved 0–255 channels plus alpha—
// shared by the `rgb()` and (aggressive-only) `hsl()` paths, so both land on
// the same form and compare equal
function formatChannels(channels, alpha) {
  if (alpha === 1) return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  // Fully transparent black is what the `transparent` keyword is defined as
  if (alpha === 0 && channels.every(channel => channel === 0)) return 'transparent';
  return `rgba(${channels.join(',')},${alpha})`;
}

// Canonicalizes one `rgb()`/`rgba()` argument list—legacy comma and modern
// space syntax alike (whitespace/comma/slash spacing has already been
// normalized by the time this runs)—when the channels are plain 0–255
// integers. Percentage or otherwise non-integer channels are left alone:
// `50%` of 255 is 127.5, and how that rounds is the browser’s business, not
// a textual equivalence. Aggressive mode accepts the rounding and resolves
// those channels, too (`Math.round`, matching what current browsers do).
function canonicalizeRgb(args, aggressive) {
  const parts = args.trim().split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4) return null;

  const channels = parts.slice(0, 3).map(part => {
    if (RE_INTEGER_CHANNEL.test(part)) return Number(part);
    if (!aggressive) return null;
    const number = part.endsWith('%') ? (Number(part.slice(0, -1)) / 100) * 255 : Number(part);
    if (!Number.isFinite(number)) return null;
    return Math.round(Math.min(Math.max(number, 0), 255));
  });
  if (channels.some(channel => channel === null || channel > 255)) return null;

  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1;
  if (alpha === null) return null;

  return formatChannels(channels, alpha);
}

// The CSS Color 4 HSL → RGB algorithm, rounded to 0–255 integer channels—
// aggressive mode only, since that rounding is exactly the step safe mode
// refuses to take on the browser’s behalf
function hslToRgb(hue, saturation, lightness) {
  const sat = saturation / 100;
  const light = lightness / 100;
  const k = n => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const channel = n => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [channel(0), channel(8), channel(4)].map(x => Math.round(x * 255));
}

// A hue is a plain angle; `deg` is the default unit
function parseHue(raw) {
  const match = RE_HUE.exec(raw);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2] ?? 'deg';
  const degrees = unit === 'deg' ? number
    : unit === 'grad' ? number * 0.9
    : unit === 'rad' ? number * (180 / Math.PI)
    : number * 360;
  return ((degrees % 360) + 360) % 360;
}

// Saturation/lightness are percentages (CSS Color 5 also allows the bare
// number spelling of the same 0–100 scale)
function parseHslComponent(raw) {
  const number = Number(raw.endsWith('%') ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0), 100);
}

// Canonicalizes one `hsl()`/`hsla()` argument list onto the same form
// `canonicalizeRgb()` produces, so `hsl(0 0% 100%)` meets `#fff` at
// `#ffffff`—aggressive mode only (rounding-based equivalence)
function canonicalizeHsl(args) {
  const parts = args.trim().split(/[\s,/]+/);
  if (parts.length < 3 || parts.length > 4) return null;

  const hue = parseHue(parts[0]);
  const saturation = parseHslComponent(parts[1]);
  const lightness = parseHslComponent(parts[2]);
  if (hue === null || saturation === null || lightness === null) return null;

  const alpha = parts.length === 4 ? parseAlpha(parts[3]) : 1;
  if (alpha === null) return null;

  return formatChannels(hslToRgb(hue, saturation, lightness), alpha);
}

// Folds equivalent color spellings onto one canonical form for comparison:
// `white`, `#fff`, `#ffffff`, `#ffffffff`, `rgb(255, 255, 255)`, and
// `rgb(255 255 255)` all become `#ffffff`; `transparent` and
// `rgba(0, 0, 0, 0)` meet at `transparent`. Expects the value to already be
// lowercased with collapsed whitespace (so it must not run for
// case-sensitive value properties, where `red` could be a counter or
// keyframes name rather than a color). Only lossless textual equivalences by
// default; aggressive mode adds the rounding-based ones (`hsl()`, percentage
// `rgb()` channels).
export function normalizeColors(value, aggressive = false) {
  let result = value.replace(RE_RGB_FUNCTION, (match, args) => canonicalizeRgb(args, aggressive) ?? match);
  if (aggressive) result = result.replace(RE_HSL_FUNCTION, (match, args) => canonicalizeHsl(args) ?? match);
  return result
    .replace(RE_NAMED_COLOR, name => `#${NAMED_COLORS[name]}`)
    .replace(RE_HEX_COLOR, (match, hex) => (
      [3, 4, 6, 8].includes(hex.length) ? `#${expandHex(hex)}` : match
    ));
}