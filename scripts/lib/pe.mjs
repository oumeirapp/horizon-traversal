const DOS_SIGNATURE = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const PE32_PLUS_MAGIC = 0x20b;
const AMD64_MACHINE = 0x8664;
const IMPORT_DIRECTORY_INDEX = 1;
const IMPORT_DESCRIPTOR_SIZE = 20;

function ensureRange(buffer, offset, length, description) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new Error(`${description} is outside the PE file`);
  }
}

function readCString(buffer, offset) {
  ensureRange(buffer, offset, 1, "import name");
  const end = buffer.indexOf(0, offset);
  if (end === -1) {
    throw new Error("PE import name is not null-terminated");
  }
  return buffer.subarray(offset, end).toString("ascii");
}

function rvaToOffset(rva, sections) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      const relative = rva - section.virtualAddress;
      if (relative >= section.rawSize) {
        break;
      }
      return section.rawOffset + relative;
    }
  }
  throw new Error(`PE RVA 0x${rva.toString(16)} is not backed by file data`);
}

export function inspectPe(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("inspectPe expects a Buffer");
  }
  ensureRange(buffer, 0, 0x40, "DOS header");
  if (buffer.readUInt16LE(0) !== DOS_SIGNATURE) {
    throw new Error("file does not have an MZ signature");
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  ensureRange(buffer, peOffset, 24, "PE header");
  if (buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) {
    throw new Error("file does not have a PE signature");
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  ensureRange(buffer, optionalOffset, optionalHeaderSize, "PE optional header");
  if (buffer.readUInt16LE(optionalOffset) !== PE32_PLUS_MAGIC) {
    throw new Error("file is not PE32+");
  }

  const sectionTableOffset = optionalOffset + optionalHeaderSize;
  ensureRange(buffer, sectionTableOffset, sectionCount * 40, "PE section table");
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20),
    });
  }

  const directoryCountOffset = optionalOffset + 108;
  ensureRange(buffer, directoryCountOffset, 4, "PE data-directory count");
  const directoryCount = buffer.readUInt32LE(directoryCountOffset);
  const imports = [];
  if (directoryCount > IMPORT_DIRECTORY_INDEX) {
    const importDirectoryOffset = optionalOffset + 112 + IMPORT_DIRECTORY_INDEX * 8;
    ensureRange(buffer, importDirectoryOffset, 8, "PE import directory");
    const importRva = buffer.readUInt32LE(importDirectoryOffset);
    const importSize = buffer.readUInt32LE(importDirectoryOffset + 4);
    if (importRva !== 0 && importSize !== 0) {
      const tableOffset = rvaToOffset(importRva, sections);
      const descriptorLimit = Math.ceil(importSize / IMPORT_DESCRIPTOR_SIZE) + 1;
      for (let index = 0; index < descriptorLimit; index += 1) {
        const descriptorOffset = tableOffset + index * IMPORT_DESCRIPTOR_SIZE;
        ensureRange(buffer, descriptorOffset, IMPORT_DESCRIPTOR_SIZE, "PE import descriptor");
        const fields = [0, 4, 8, 12, 16].map((fieldOffset) =>
          buffer.readUInt32LE(descriptorOffset + fieldOffset),
        );
        if (fields.every((value) => value === 0)) {
          break;
        }
        if (fields[3] === 0) {
          throw new Error("PE import descriptor has no DLL name");
        }
        imports.push(readCString(buffer, rvaToOffset(fields[3], sections)));
        if (index === descriptorLimit - 1) {
          throw new Error("PE import descriptor table has no terminator");
        }
      }
    }
  }

  return { machine, imports: [...new Set(imports)] };
}

export function assertAmd64Pe(buffer, dependencyPolicy, label = "native binary") {
  const inspection = inspectPe(buffer);
  if (inspection.machine !== AMD64_MACHINE) {
    throw new Error(
      `${label} uses PE machine 0x${inspection.machine.toString(16)}; expected AMD64 0x8664`,
    );
  }

  const allowed = new Set(
    (dependencyPolicy?.allowedNames ?? []).map((name) => name.toLowerCase()),
  );
  const denied = new Set(
    (dependencyPolicy?.deniedNames ?? []).map((name) => name.toLowerCase()),
  );
  for (const dependency of inspection.imports) {
    const normalized = dependency.toLowerCase();
    if (denied.has(normalized)) {
      throw new Error(`${label} imports forbidden runtime ${dependency}`);
    }
    const isWindowsApiSet =
      normalized.startsWith("api-ms-win-") || normalized.startsWith("ext-ms-win-");
    if (!allowed.has(normalized) && !isWindowsApiSet) {
      throw new Error(`${label} imports undeclared runtime ${dependency}`);
    }
  }

  return inspection;
}

export const PE_AMD64_MACHINE = AMD64_MACHINE;
