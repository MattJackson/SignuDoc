import assert from "node:assert/strict";
import { test } from "node:test";

import { googleProfileFields, readGoogleProfile } from "./google-profile.ts";

const PICTURE = "https://lh3.googleusercontent.com/a/ACg8ocJ-example=s96-c";

test("the name and picture are taken from Google's claims", () => {
  assert.deepEqual(
    readGoogleProfile({ name: "  Matt   Jackson ", picture: PICTURE }),
    { image: PICTURE, name: "Matt Jackson" },
  );
});

test("a picture anywhere but Google's photo host, or not https, is dropped", () => {
  for (const picture of [
    "http://lh3.googleusercontent.com/a/x",
    "https://lh3.googleusercontent.com.evil.example/a/x",
    "https://evil.example/a.png",
    "https://user@lh3.googleusercontent.com/a/x",
    "https://lh3.googleusercontent.com:8443/a/x",
    "javascript:alert(1)",
    `https://lh3.googleusercontent.com/${"a".repeat(3000)}`,
    42,
  ]) {
    assert.equal(readGoogleProfile({ picture }).image, null, String(picture));
  }
});

test("nothing sent leaves nothing to change", () => {
  assert.deepEqual(readGoogleProfile(null), { image: null, name: null });
  assert.deepEqual(googleProfileFields({ name: " " }), {});
  assert.deepEqual(googleProfileFields({ name: "Ann", picture: PICTURE }), {
    image: PICTURE,
    name: "Ann",
  });
});

test("Google's photo hosts lh3 to lh6 are accepted, and no other", () => {
  for (const number of [3, 4, 5, 6]) {
    const picture = `https://lh${String(number)}.googleusercontent.com/a/x=s96-c`;

    assert.equal(readGoogleProfile({ picture }).image, picture);
  }

  for (const host of [
    "lh2.googleusercontent.com",
    "lh7.googleusercontent.com",
    "lh33.googleusercontent.com",
    "googleusercontent.com",
  ]) {
    assert.equal(
      readGoogleProfile({ picture: `https://${host}/a/x` }).image,
      null,
      host,
    );
  }
});

test("a name is capped at 200 characters, and a missing, blank or non-string name is no name", () => {
  assert.equal(readGoogleProfile({ name: "a".repeat(300) }).name?.length, 200);
  assert.equal(readGoogleProfile({ name: "a".repeat(200) }).name?.length, 200);

  for (const name of [
    undefined,
    null,
    42,
    ["Ann"],
    { value: "Ann" },
    " \t\n ",
  ]) {
    assert.equal(readGoogleProfile({ name }).name, null, String(name));
  }
});
