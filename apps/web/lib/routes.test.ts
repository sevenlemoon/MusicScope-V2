import { primaryRoutes, secondaryRoutePatterns } from "./routes";

describe("route manifest", () => {
  it("opens with separation and keeps the library one click away", () => {
    expect(primaryRoutes.map((route) => route.href)).toEqual(["/", "/library"]);
    expect(primaryRoutes[0].zhLabel).toBe("音轨分离");
  });

  it("prepares every secondary route", () => {
    expect(secondaryRoutePatterns).toEqual(expect.arrayContaining(["/connect", "/album/[id]", "/playlist/[id]", "/track/[id]", "/settings"]));
  });
});
