import assert from "node:assert/strict";
import { test } from "node:test";
import { findPhrase, sentences, tokens } from "../src/shared/text.ts";

test("tokens are lower-cased words, and each Chinese character on its own", () => {
  assert.deepEqual(tokens("Don’t use HTTP/2, 用React写"), ["don't", "use", "http", "2", "用", "react", "写"]);
});

test("a phrase is found from a starting point onwards", () => {
  const said = tokens("the cache, then the database, then the cache again");
  assert.equal(findPhrase(tokens("the cache"), said), 0);
  assert.equal(findPhrase(tokens("the cache"), said, 1), 6);
  assert.equal(findPhrase(tokens("the server"), said), -1);
});

test("narration is split into sentences", () => {
  assert.deepEqual(sentences("First we sort the list. Then we search it in half the time!"), ["First we sort the list.", "Then we search it in half the time!"]);
  assert.deepEqual(sentences("先别急着看答案。你猜猜看，这个请求会到哪里？"), ["先别急着看答案。", "你猜猜看，这个请求会到哪里？"]);
});

test("abbreviations, decimals and one-word sentences do not become sentences of their own", () => {
  assert.deepEqual(sentences("Dr. Smith measured 3.5 volts across the whole circuit."), ["Dr. Smith measured 3.5 volts across the whole circuit."]);
  assert.deepEqual(sentences("Does it scale to a million users? Yes!"), ["Does it scale to a million users? Yes!"]);
});

test("a long sentence is cut at its commas", () => {
  const long = "When the request arrives at the load balancer, it picks one of the healthy servers behind it, forwards the request there, waits for the response to come back, and finally returns that response to the client that asked for it in the first place.";
  const parts = sentences(long);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(" "), long);
});
