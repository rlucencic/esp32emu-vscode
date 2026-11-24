# esp32emu-vscode roadmap

Proposed work in priority order. See [Development](README.md#development) for the current project.

1. **Add ARM2 support for the Archimedes.** Use the existing `arch: arm2`
   debugger from the Archimedes host with `src/session.ts`. Verify four-byte
   disassembly alignment, 26-bit code addresses and ARM2 register and stack
   display, including R15 with status bits set. Add a real-host attach and step
   case.

2. **Preserve Atari XEX load order and INITAD semantics.** Extend
   `src/loaders/program.ts` to retain segment and INITAD order. Design how an
   init routine returns to the debugger before later segments load. Exercise
   multiple init stages and final RUNAD in an Atari XL host smoke test.

3. **Design data breakpoints with the shared debugger.** Agree on a protocol
   capability and stop reason with `esp32emu` before exposing DAP data
   breakpoints. Start with one host CPU and a fixture that distinguishes guest
   reads/writes from debugger inspection, then measure the cost with no
   watchpoints installed.
