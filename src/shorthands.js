// Maps each shorthand property to the longhands it sets—physical and
// logical alike, but not physical ↔ logical pairs (e.g., `margin-left` vs
// `margin-inline-start`): which physical side a logical longhand resolves to
// depends on the element’s writing mode/direction, which isn’t knowable from
// static CSS, so that pairing is deliberately left unmapped. Not exhaustive—
// covers the shorthands common enough to matter for the merge-safety check
// below; extend as needed.
export const SHORTHAND_LONGHANDS = {
  margin: [
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'margin-block', 'margin-block-start', 'margin-block-end',
    'margin-inline', 'margin-inline-start', 'margin-inline-end',
  ],
  'margin-block': ['margin-block-start', 'margin-block-end'],
  'margin-inline': ['margin-inline-start', 'margin-inline-end'],
  padding: [
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'padding-block', 'padding-block-start', 'padding-block-end',
    'padding-inline', 'padding-inline-start', 'padding-inline-end',
  ],
  'padding-block': ['padding-block-start', 'padding-block-end'],
  'padding-inline': ['padding-inline-start', 'padding-inline-end'],
  inset: [
    'top', 'right', 'bottom', 'left',
    'inset-block', 'inset-block-start', 'inset-block-end',
    'inset-inline', 'inset-inline-start', 'inset-inline-end',
  ],
  'inset-block': ['inset-block-start', 'inset-block-end'],
  'inset-inline': ['inset-inline-start', 'inset-inline-end'],
  border: [
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-width', 'border-style', 'border-color',
    'border-top-width', 'border-top-style', 'border-top-color',
    'border-right-width', 'border-right-style', 'border-right-color',
    'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
    'border-left-width', 'border-left-style', 'border-left-color',
  ],
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-style': ['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  'border-radius': [
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius',
  ],
  'border-image': [
    'border-image-source', 'border-image-slice', 'border-image-width',
    'border-image-outset', 'border-image-repeat',
  ],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  background: [
    'background-image', 'background-position', 'background-size',
    'background-repeat', 'background-origin', 'background-clip',
    'background-attachment', 'background-color',
  ],
  font: [
    'font-style', 'font-variant', 'font-weight', 'font-stretch',
    'font-size', 'line-height', 'font-family',
  ],
  'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  overflow: ['overflow-x', 'overflow-y'],
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['grid-row-gap', 'grid-column-gap'],
  'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'],
  'place-self': ['align-self', 'justify-self'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],
  transition: ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'],
  animation: [
    'animation-name', 'animation-duration', 'animation-timing-function',
    'animation-delay', 'animation-iteration-count', 'animation-direction',
    'animation-fill-mode', 'animation-play-state',
  ],
  'text-decoration': [
    'text-decoration-line', 'text-decoration-style',
    'text-decoration-color', 'text-decoration-thickness',
  ],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],
  'grid-area': [
    'grid-row', 'grid-column',
    'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  ],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
};

function expandProperty(prop) {
  return new Set([prop, ...(SHORTHAND_LONGHANDS[prop] ?? [])]);
}

// “True” if setting one of the two (already-normalized) properties can affect
// the same underlying longhand as the other—either because they’re the same
// property, one is a shorthand that expands into the other, or their
// expansions share a longhand (e.g., `border-top` and `border-color` both
// expand to include `border-top-color`, even though neither raw name is a
// member of the other’s expansion)
export function propertiesOverlap(a, b) {
  if (a === b) return true;
  const expandedA = expandProperty(a);
  const expandedB = expandProperty(b);
  for (const prop of expandedA) {
    if (expandedB.has(prop)) return true;
  }
  return false;
}