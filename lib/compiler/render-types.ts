export interface BuildContext {
  substrateRoot: string;
  repoRoot: string;
  packageVersion: string;
}
export interface RenderItem {
  key: string;
  outputRelPath: string;
  sourceSha256: string;
  build: () => string | Buffer;
  mode?: number;
  type?: 'block';
  beginMarker?: string;
  endMarker?: string;
}
