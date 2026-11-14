import { getSchema, type JSONContent } from "@tiptap/react";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { isDocEmpty } from "./doc-utils";
import { baseExtensions } from "./extensions";

/**
 * Fixed Yjs client id for seeding from legacy JSON. Every tab that seeds the same legacy document
 * produces byte-identical operations, so concurrent seeds merge into one copy instead of duplicating.
 */
const SEED_CLIENT_ID = 1;

/** Yjs update that fills an empty canvas with its pre-Yjs content, or null if there's nothing to seed. */
export function buildSeedUpdate(legacy: JSONContent | null | undefined): Uint8Array | null {
  if (!legacy || isDocEmpty(legacy)) return null;
  const tmp = new Y.Doc();
  tmp.clientID = SEED_CLIENT_ID;
  try {
    prosemirrorJSONToYXmlFragment(getSchema(baseExtensions()), legacy, tmp.getXmlFragment("default"));
    return Y.encodeStateAsUpdate(tmp);
  } catch {
    // Content that doesn't fit the schema can't be seeded; start empty rather than crash.
    return null;
  } finally {
    tmp.destroy();
  }
}
