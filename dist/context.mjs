export async function handleRequest(context, middlewares) {
  const compose = (i) => {
    if (i >= middlewares.length) {
      return Promise.resolve();
    }
    return middlewares[i](context, () => compose(i + 1));
  };
  await compose(0);
}
