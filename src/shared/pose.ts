/**
 * Schemas the 3D scene view can render as a set of named poses. Kept in
 * `shared/` so both the webview (pose extraction, view routing) and any future
 * extension-side use agree on the allow-list. The renderer itself is
 * schema-agnostic — adding a schema means adding a branch to extractPoseSet().
 */
export const POSE_SCHEMAS = new Set<string>(["safari_sdk.protos.logging.Trackers"]);

export function isPoseSchema(schemaName: string): boolean {
  return POSE_SCHEMAS.has(schemaName);
}
