# Rebuilding the WebGPU module

    # 1. Unpack the ptts crate and apply the read-back patch
    cd vendor/pocket-tts-wasm-gpu/wrapper-src
    curl -L https://static.crates.io/crates/ptts/ptts-0.2.3.crate | tar xz
    mv ptts-0.2.3 ptts-patched
    (cd ptts-patched && patch -p1 < ../../ptts-webgpu-readback.patch)

    # 2. Build for the browser
    cargo build --release --target wasm32-unknown-unknown
    cargo install wasm-bindgen-cli --version 0.2.100 --locked
    wasm-bindgen --target web --out-dir ../ target/wasm32-unknown-unknown/release/ptts_wasm.wasm

    # 3. iOS check: must pass (no relaxed SIMD)
    wasm-tools validate --features=-relaxed-simd ../ptts_wasm_bg.wasm

`.cargo/config.toml` sets `+simd128` and the getrandom browser backend.
