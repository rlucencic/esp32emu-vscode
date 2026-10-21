# esp32emu Debugger for VS Code

![6502](https://img.shields.io/badge/CPU-6502-blue) ![65C816](https://img.shields.io/badge/CPU-65C816-blue)
![Z80](https://img.shields.io/badge/CPU-Z80-blue) ![68000](https://img.shields.io/badge/CPU-68000-blue) ![x86](https://img.shields.io/badge/CPU-x86-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC) ![License](https://img.shields.io/badge/license-MIT-green)

Write a program for a Commodore 64, an Atari 800XL, a ZX Spectrum, an MSX or
an Apple IIGS in VS Code on a Mac, Windows or Linux. Then debug it while it
runs on the real machine's emulator on an ESP32 board, over WiFi.

This extension is the debugger for the
[esp32emu](https://github.com/rlucencic/esp32emu) emulators. They run on the
Makerfabs MaTouch ESP32-S3 7" and the M5Stack Tab5:

| Machine | Project | CPUs (threads) |
|---|---|---|
| Atari 800XL, 130XE | [esp32xl](https://github.com/rlucencic/esp32xl) | 6502 |
| Commodore 64, 128 | [esp32cbm](https://github.com/rlucencic/esp32cbm) | 6510 or 8502, Z80 (128), drive 8, drive 9 |
| ZX Spectrum 128K, +2, +3 | [esp32zx](https://github.com/rlucencic/esp32zx) | Z80 |
| Amstrad CPC, CPC Plus | [esp32cpc](https://github.com/rlucencic/esp32cpc) | Z80 |
| MSX, MSX2 | [esp32msx](https://github.com/rlucencic/esp32msx) | Z80 |
| Apple IIGS | [esp32gs](https://github.com/rlucencic/esp32gs) | 65C816 |
| Atari STE | [esp32ste](https://github.com/rlucencic/esp32ste) | 68000 |
| Macintosh Plus, SE, Classic | [esp32mac](https://github.com/rlucencic/esp32mac) | 68000 |
| IBM PC/XT, PC/AT | [esp32pc](https://github.com/rlucencic/esp32pc) | 8088, 8086 or 80286 (addresses linear: CS:IP as the CPU forms it) |
| Amiga 500, 2000, 600 | [esp32ami](https://github.com/rlucencic/esp32ami) | 68000 |

Each machine's desktop build (`xl_host`, `cbm_host`, ...) can run the
debugger too. You can then debug on the computer, without a board, and use
the same launch configuration with another host.

## Features

- **Breakpoints:**
  - **Kinds:** on source lines (assembler or C), on labels (function breakpoints), and in the disassembly.
  - **Options:** conditions (`[$80] == 5 && X > 3`), hit counts, and log points (`counter is {[$80]}`).
- **Steps** by source line or by instruction: over, into and out of calls.
  - An interrupt that comes during a step runs through, so a step never stops in the VBI or a raster interrupt.
  - Stepping over a call works by the stack, so calls that take their parameters inline still come back: ProDOS MLI, `PRIMM`, GS/OS, Mac and ST traps.
- **Registers and flags:** you can change both. A **stack** view shows the top of the stack, and **callers** are found from the return addresses on the stack.
- **Memory:** VS Code's memory view and hex editor, reading and writing the machine's RAM as the CPU sees it.
- **Disassembly** with labels and source lines.
- **Expressions** in Watch, hovers and the Debug Console: registers, flags, labels, `[addr]`, `w[addr]` and `l[addr]` (the CPU's byte order), and C-like operators.
- **Program loading:**
  - **Formats:** `.prg`, `.xex`, `.tap` (CODE blocks), AMSDOS, MSX BLOAD, ELF and raw binaries.
  - **Commodore BASIC programs** are `RUN`.
  - A **disk image** can be uploaded to the board's SD card and inserted, then the machine reset.
- **Symbols:**
  - `ld65 --dbgfile` (`.dbg`): cc65, ca65.
  - `sjasmplus --sld` (`.sld`).
  - ELF with DWARF 2 to 5: m68k-elf-gcc, vasm `-Felf`, llvm-mos.
  - The label files of almost every assembler: VICE `al` (ca65 `-Ln`), 64tass, ACME, KickAssembler, z88dk `.map`, `name = $1234`, `name equ ...`.
- **The machine's screen** in a panel beside the code, live while it runs. You can also **type** on the machine's keyboard from VS Code.
- **Several CPUs:** for example, debug the C64 and the 1541's 6502 at the same time. Every CPU stops together.
- **Finds the boards** on the network over mDNS.

## Getting started

1. **Flash a machine with the debugger.** esp32emu's projects have it on by default: menuconfig → Debugger, TCP port 6502. Start the machine; its setup screen must be closed.
2. **Install the extension.** From a `.vsix`, use Extensions → … → Install from VSIX.
3. **Add a launch configuration** (Run → Add Configuration → esp32emu) and press F5.

   An empty `host` asks which board to use: the boards on the network are listed, and so is a desktop build on `127.0.0.1`.

```jsonc
{
    "type": "esp32emu",
    "request": "launch",
    "name": "C64: hello",
    "host": "commodore.local",
    "program": "${workspaceFolder}/build/hello.prg",   // hello.dbg next to it is found
    "stopOnEntry": true
}
```

### On the computer, without a board

Each machine's host build serves the debugger when its `<M>_DEBUG`
environment variable gives a port. Here the Atari XL:

```bash
make -C ../esp32xl/components/atari_xl/host
XL_DEBUG=6502 ../esp32xl/components/atari_xl/host/build/xl_host ../esp32xl/roms/atarixl.rom
```

Then launch with `"host": "127.0.0.1"` and `"showScreen": true`; the host
build has no window of its own. The variables are `XL_DEBUG`, `CBM_DEBUG`,
`ZX_DEBUG`, `CPC_DEBUG`, `MSX_DEBUG`, `GS_DEBUG`, `ST_DEBUG` and
`MAC_DEBUG`.

You can try the extension without any ROMs on esp32emu's demo machine: a
bare 6502 or Z80 with RAM and an interrupt every frame.

```bash
make -C ../esp32emu/components/emudbg/test && ../esp32emu/components/emudbg/test/build/demo 6502 6502
```

## Launch configurations

| Attribute | |
|---|---|
| `host`, `port` | The board (`atari-xl.local`, an address) or `127.0.0.1`; port 6502. An empty host asks |
| `program` | The program to load |
| `format` | `auto` (by extension and contents), `raw`, `prg`, `xex`, `tap`, `amsdos`, `msx`, `elf` |
| `loadAddress` | For raw programs: `"$2000"`, `"0x2000"` or a number |
| `entry` | Where to start: an address or a label. `"none"` leaves the PC alone. Default: the format's |
| `cpu` | The CPU the program and symbols are for: `"Z80"`, `"drive 8"` or a number. Default: the first |
| `symbols` | Symbol files: a path, or a list of paths or `{ "file", "cpu", "offset" }`. Default: the program's name with `.dbg`, `.sld`, `.elf`, `.lbl`, `.labels`, `.sym`, `.vs` or `.map` |
| `sourceRoot` | Where relative source names in symbol files are (default: the symbol file's folder) |
| `reset`, `resetFrames` | Reset first (default) and let the ROM start for that many frames (150) before loading |
| `typeAfterLoad` | Text to type once loaded, as on a PC keyboard (`\n` is Return; the Commodores' capitals are lowercase letters: `"run\n"`). A Commodore BASIC program is run by default |
| `stopOnEntry` | Stop at the program's first instruction |
| `disk` | `{ "file", "drive" }`: upload a disk image to the board and insert it (boards only) |
| `stackScan` | Callers from the stack in the call stack (default on) |
| `showScreen` | Open the machine's screen beside the editor |

An `attach` configuration debugs whatever runs on the machine now: `host`,
`port`, `symbols`, `cpu`, `stopOnEntry` (pause it).

### Examples by toolchain

```jsonc
// cc65 for the Atari: cl65 -t atari -g -Wl --dbgfile,build/game.dbg -o build/game.xex game.c
{ "type": "esp32emu", "request": "launch", "name": "Atari", "host": "atari-xl.local",
  "program": "${workspaceFolder}/build/game.xex" }

// sjasmplus for the Spectrum: sjasmplus --sld=build/game.sld --raw=build/game.bin game.asm
{ "type": "esp32emu", "request": "launch", "name": "Spectrum", "host": "spectrum.local",
  "program": "${workspaceFolder}/build/game.bin", "loadAddress": "$8000", "resetFrames": 100 }

// 64tass for the C64: 64tass -o build/demo.prg --vice-labels -l build/demo.lbl demo.asm
{ "type": "esp32emu", "request": "launch", "name": "C64", "host": "commodore.local",
  "program": "${workspaceFolder}/build/demo.prg", "symbols": "${workspaceFolder}/build/demo.lbl" }

// The 1541's own code, next to the C64's
{ "type": "esp32emu", "request": "attach", "name": "Drive", "host": "commodore.local",
  "symbols": [ "build/fastload.lbl", { "file": "build/drivecode.lbl", "cpu": "drive 8" } ] }

// m68k-elf-gcc for the ST (code linked to a fixed address)
{ "type": "esp32emu", "request": "launch", "name": "ST", "host": "atari-ste.local",
  "program": "${workspaceFolder}/build/demo.elf" }
```

## In the Debug Console

- **Expressions:** `PC`, `A + X`, `[$D020] & $0F`, `w[$FFFE]`, `bump + 3`, `C` (a flag).
- **Protocol commands:** `>` sends a line straight to the machine, for example `>frames 50`, `>disasm 0 $E000 8`, `>state`, `>screen`.
- **Commands** (Command Palette, esp32emu): show the machine's screen, type text, reset the machine, run frames and stop.

## How it works

The emulators' CPU cores test one pointer before each instruction: a map
with a bit per address (16-bit CPUs) or per 256-byte page (24-bit). It is
NULL without a debugger. When an instruction's bit is set, the debugger
looks at it. To stop, it blocks the emulation task between two instructions,
and the board's network task answers meanwhile. Pausing and stepping set
every bit.

The protocol is lines of text and JSON over TCP. It is described in
esp32emu's [`docs/debugger.md`](https://github.com/rlucencic/esp32emu/blob/main/docs/debugger.md),
and `nc commodore.local 6502` speaks it too.

## Limitations

- No watchpoints (breakpoints on data) yet.
- An Atari XEX's INITAD routines don't run during the load; RUNAD does.
- ST and Mac programs load as raw or ELF code at fixed addresses. TOS `.prg`
  and Mac applications start from a disk image (`disk`): attach with their
  symbols and an `offset`.
- Steps run the stepping CPU an instruction at a time through the debugger.
  Stepping over a long call (a disk load) is slower than real time.
- The call stack beyond the current frame is a guess from the stack.

## Development

```bash
npm install
npm test                 # compile and run the unit tests
make -C ../esp32emu/components/emudbg/test
npm run test:host        # the adapter against esp32emu's demo machine
npm run bundle           # dist/extension.js
npm run package          # the .vsix
```

Press F5 in this folder to run the extension in a second VS Code window. The
adapter also runs on its own over stdio (`node out/src/adapter.js`), for
other editors.

## Licence

MIT, see [LICENSE](LICENSE).
