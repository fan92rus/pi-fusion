import { describe, expect, it } from "vitest";
import fusionExtension from "../extensions/pi-fusion/index.ts";

describe("scaffold", () => {
  it("exports a loadable extension factory", () => {
    expect(typeof fusionExtension).toBe("function");
  });
});
