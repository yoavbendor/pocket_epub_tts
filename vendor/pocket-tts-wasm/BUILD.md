# Rebuilding the WebAssembly module

    cd vendor/pocket-tts-wasm/wrapper-src
    cargo build --release --target wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --version 0.2.100 --locked   # must match the crate
    wasm-bindgen --target web --out-dir ../ target/wasm32-unknown-unknown/release/ptts_wasm.wasm
    wasm-tools validate --features=-relaxed-simd ../ptts_wasm_bg.wasm   # iOS check

`.cargo/config.toml` sets `-C target-feature=+simd128` and the getrandom browser
backend. Do not add `+relaxed-simd`.
