export const prettyJSON = (options) => {
  const targetQuery = options?.query ?? "pretty";
  return async function prettyJSON2(c, next) {
    const pretty = !!new URL(c.req.url).searchParams.has(targetQuery);
    await next();
    if (pretty && c.res.headers.get("Content-Type")?.startsWith("application/json")) {
      const obj = await c.res.json();
      c.res = new Response(
        JSON.stringify(obj, null, options?.space ?? 2),
        c.res
      );
    }
  };
};
