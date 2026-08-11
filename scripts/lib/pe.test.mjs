import assert from "node:assert/strict";
import test from "node:test";

import { assertAmd64Pe, inspectPe, PE_AMD64_MACHINE } from "./pe.mjs";

function peFixture({ machine = PE_AMD64_MACHINE, imports = ["KERNEL32.dll"] } = {}) {
  const buffer = Buffer.alloc(0x600);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(16, optional + 108);
  buffer.writeUInt32LE(0x1000, optional + 120);
  buffer.writeUInt32LE((imports.length + 1) * 20, optional + 124);
  const section = optional + 0xf0;
  buffer.write(".rdata", section, "ascii");
  buffer.writeUInt32LE(0x400, section + 8);
  buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0x400, section + 16);
  buffer.writeUInt32LE(0x200, section + 20);

  let nameRva = 0x1100;
  imports.forEach((name, index) => {
    const descriptor = 0x200 + index * 20;
    buffer.writeUInt32LE(nameRva, descriptor + 12);
    buffer.write(`${name}\0`, 0x200 + (nameRva - 0x1000), "ascii");
    nameRva += name.length + 1;
  });
  return buffer;
}

test("reads AMD64 imports", () => {
  assert.deepEqual(inspectPe(peFixture()).imports, ["KERNEL32.dll"]);
});

test("rejects the wrong architecture", () => {
  assert.throws(
    () => assertAmd64Pe(peFixture({ machine: 0x14c }), { allowedNames: [] }),
    /expected AMD64/,
  );
});

test("rejects a malformed PE file", () => {
  assert.throws(() => inspectPe(Buffer.from("not a PE file")), /DOS header/);
});

test("rejects undeclared dependencies", () => {
  assert.throws(
    () => assertAmd64Pe(peFixture({ imports: ["unexpected.dll"] }), { allowedNames: [] }),
    /undeclared runtime unexpected\.dll/,
  );
});

test("rejects explicitly forbidden runtimes", () => {
  assert.throws(
    () =>
      assertAmd64Pe(
        peFixture({ imports: ["libwinpthread-1.dll"] }),
        {
          allowedNames: ["libwinpthread-1.dll"],
          deniedNames: ["libwinpthread-1.dll"],
        },
      ),
    /forbidden runtime libwinpthread-1\.dll/,
  );
});
