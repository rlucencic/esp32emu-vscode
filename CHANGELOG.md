# Changes

## Unreleased

- The x86 (esp32pc's IBM PC/XT and PC/AT): linear addresses (CS:IP as the
  CPU forms it), the segment registers, callers found by their near and far
  CALLs, the stack in words. Tested against esp32pc's host build
  (`test/integration/pc.test.ts`).
- Floating-point registers (protocol flag 16: an IEEE single's bits): the
  x86's coprocessor stack ST0-ST7 as numbers, `empty` for empty ones, next
  to its control, status and tag words.

## 0.1.0 (2026-10-18)

The first version.

- Debugs the programs in esp32emu's machines (Atari 800XL/130XE, Commodore
  64/128 and their drives, ZX Spectrum, Amstrad CPC, MSX, Apple IIGS, Atari
  STE, Macintosh) on the MaTouch ESP32-S3 and the M5Stack Tab5, or in the
  machines' desktop builds.
- Breakpoints on source lines, labels and addresses, with conditions, hit
  counts and log messages; steps that run through interrupts and over calls
  with inline parameters; registers and flags; the stack; memory; the
  disassembly with source lines.
- Loads .prg, .xex, .tap, AMSDOS, MSX BLOAD, ELF and raw programs, types
  RUN for Commodore BASIC programs, uploads disk images to the board.
- Symbols from ld65 (.dbg), sjasmplus (.sld), ELF with DWARF 2-5, and label
  files of most assemblers.
- The machine's screen in a panel; typing on the machine's keyboard.
