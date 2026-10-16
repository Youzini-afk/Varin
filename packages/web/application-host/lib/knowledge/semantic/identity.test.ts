import { expect, it } from "vitest";
import { LOCAL_DEFAULT_SPACE, spaceIdOf } from "./identity.js";

it("keeps differently packed source vectors in separate spaces", () => {
  expect(spaceIdOf(LOCAL_DEFAULT_SPACE)).not.toBe(
    spaceIdOf({ ...LOCAL_DEFAULT_SPACE, maxTokens: LOCAL_DEFAULT_SPACE.maxTokens / 2 }),
  );
});
