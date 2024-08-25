// @ts-check
import { domStorageCache } from "jsr:@mega/memoize/cache/domStorage";
import { memoizeAsync } from "jsr:@mega/memoize/async";

export const memoizedFetch = memoizeAsync(
  /**
   * @param {URL} url
   */
  async (url) => {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${url.href}: ${resp.statusText}`);
    }
    return {
      text: await resp.text(),
      url: resp.url,
      headers: Object.fromEntries(
        [...resp.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
      ),
      date: new Date(),
    };
  },
  {
    cache: domStorageCache(localStorage, "fetch"),
    shouldRecalculate: (response) => {
      const age = Date.now() - new Date(response.date).getTime();
      return age > 1000 * 60 * 60 * 24; // 1 day
    },
  },
);
