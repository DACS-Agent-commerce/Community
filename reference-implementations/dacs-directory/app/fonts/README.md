# Bundled Directory fonts

The unmodified variable TrueType fonts are distributed under the adjacent SIL
Open Font License 1.1 files. Next.js serves these local assets through
`next/font/local`; production builds need no Google Fonts connection.

Downloaded from the public Google Fonts repository on 2026-11-07:

- https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/PlusJakartaSans%5Bwght%5D.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/plusjakartasans/OFL.txt
- https://raw.githubusercontent.com/google/fonts/main/ofl/sourcecodepro/SourceCodePro%5Bwght%5D.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/sourcecodepro/OFL.txt

SHA-256 of the bundled font bytes:

- PlusJakartaSans-variable.ttf: `89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdedcf02ee9099ff68bc8`
- SourceCodePro-variable.ttf: `b400fc584e10aff25d0e775ce181b4fc1c5ea1b5dc37b81aeb2084375b945790`

From `reference-implementations/dacs-directory`, run the credential-free focused
regression and font-weight boundary checks with:

```sh
node --test test/offline-fonts.test.mjs
```

This is a build dependency change and introduces no DACS protocol interpretation.

Check: `cd reference-implementations/dacs-directory && node --test test/offline-fonts.test.mjs`
