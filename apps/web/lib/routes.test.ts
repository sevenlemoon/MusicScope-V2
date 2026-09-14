import { primaryRoutes, secondaryRoutePatterns } from "./routes";

describe("route manifest", () => {
  it("contains every R0 primary route exactly once", () => {
    expect(primaryRoutes.map((route) => route.href)).toEqual(["/", "/discover", "/library", "/live", "/studio", "/insights"]);
  });

  it("prepares every secondary route", () => {
    expect(secondaryRoutePatterns).toEqual(expect.arrayContaining(["/connect", "/artist/[id]", "/album/[id]", "/playlist/[id]", "/track/[id]", "/settings"]));
  });
});

