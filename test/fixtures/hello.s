; A tiny program for the extension's tests (Atari XL, at $2000)
        .org $2000
counter = $80

start:  lda #0
        sta counter
loop:   jsr bump
        jmp loop

        .res 8          ; (to $2010)
bump:   inc counter
        lda counter
        sta $0600
        rts
