/** SVG marker definitions for edge arrowheads. */
export const ARROW_FWD_ID = 'codoptic-arrow-fwd';
export const ARROW_BWD_ID = 'codoptic-arrow-bwd';
export const ARROW_THICK_ID = 'codoptic-arrow-thick';

export const MARKER_DEFS = `
  <marker id="${ARROW_FWD_ID}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.8" markerHeight="4.8" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 Z" fill="rgba(180, 188, 204, 0.85)"/>
  </marker>
  <marker id="${ARROW_BWD_ID}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="4.8" markerHeight="4.8" orient="auto">
    <path d="M10,0 L0,5 L10,10 Z" fill="rgba(180, 188, 204, 0.85)"/>
  </marker>
  <marker id="${ARROW_THICK_ID}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 Z" fill="rgba(220, 226, 240, 0.95)"/>
  </marker>
`;
