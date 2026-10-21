import { apiRequest, ApiRequestError } from "./api-client";

describe("API error responses", () => {
  it.each([null, [], { detail: null }, { detail: [] }, { detail: { code: 42, message: {} } }])(
    "preserves the HTTP status for malformed error payload %j",
    async (payload) => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => payload });
      await expect(apiRequest("/unavailable")).rejects.toMatchObject({
        name: "ApiRequestError", status: 503, message: "MusicScope API request failed (503)",
      });
    },
  );

  it("preserves structured service errors", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 413, json: async () => ({ detail: { code: "UPLOAD_TOO_LARGE", message: "File too large." } }) });
    const error = await apiRequest("/upload").catch(reason => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 413, code: "UPLOAD_TOO_LARGE", message: "File too large." });
  });
});
