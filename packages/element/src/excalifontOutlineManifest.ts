import { EXCALIFONT_OUTLINE_MANIFEST } from "./excalifontOutlineManifest.generated";

export type ExcalifontOutlineGlyph = {
  advanceWidth: number;
  leftSideBearing: number;
  path: string;
  xMax: number;
  xMin: number;
  yMax: number;
  yMin: number;
};

export type ExcalifontOutlineManifest = {
  ascender: number;
  descender: number;
  glyphs: Record<string, ExcalifontOutlineGlyph>;
  supportedCodePoints: readonly number[];
  unitsPerEm: number;
  version: 1;
};

export const getExcalifontOutlineGlyph = (codePoint: number) => {
  return EXCALIFONT_OUTLINE_MANIFEST.glyphs[String(codePoint)] || null;
};

export { EXCALIFONT_OUTLINE_MANIFEST };