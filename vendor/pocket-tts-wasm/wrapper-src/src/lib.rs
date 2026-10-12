// WebAssembly wrapper around the ptts (xn-ptts) library, exposing the same JavaScript API as
// the Pocket TTS WASM demo, so the demo's worker.js can drive it unchanged:
//   init(), Model, cpu_features()
//   new Model(weightsBytes, 'q8'), model.add_voice(bytes), model.prepare_text(text),
//   model.sample_rate(), model.start_generation(voiceIndex, tokenIds, framesAfterEos, temperature),
//   model.generation_step() -> Float32Array | undefined
//
// Tokenization stays in JavaScript (the worker's SentencePiece decoder), so the Rust side only
// receives token ids.
use std::io::Cursor;

use js_sys::Array;
use ptts::mimi::MimiDecoderState;
use ptts::transformer::LayerAttentionState;
use ptts::tts_model::{TTSConfig, TTSModel, TTSState, prepare_text_prompt};
use wasm_bindgen::prelude::*;
use xn::nn::VB;
use xn::{BackendQ, Tensor};

type Q = xn::quantized::Q80F32;
type B = <Q as BackendQ>::B;

// Token budget of each flow-LM state (voice prompt + text + generated frames).
const SEQ_BUDGET: usize = 2048;
// Mimi streaming context, in frames.
const MIMI_CONTEXT: usize = 250;
const TEMPERATURE_DEFAULT: f32 = 0.7;

fn js_err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

// Keys in the upstream checkpoint are renamed to the names this crate's modules expect.
// Copied from the ptts examples (model_helpers.rs).
fn remap_key(name: &str) -> Option<String> {
    if name.contains("flow.w_s_t") || name.contains("quantizer.vq") || name.contains("quantizer.logvar_proj") {
        return None;
    }
    let mut name = name.to_string();
    name = name.replace(
        "flow_lm.condition_provider.conditioners.speaker_wavs.output_proj.weight",
        "flow_lm.speaker_proj_weight",
    );
    name = name.replace(
        "flow_lm.condition_provider.conditioners.transcript_in_segment.",
        "flow_lm.conditioner.",
    );
    name = name.replace("flow_lm.backbone.", "flow_lm.transformer.");
    name = name.replace("flow_lm.flow.", "flow_lm.flow_net.");
    name = name.replace("mimi.model.", "mimi.");
    Some(name)
}

// Frames an utterance of `num_tokens` tokens may generate before it is cut off (ptts example).
fn max_frames_for(num_tokens: usize) -> usize {
    ((num_tokens as f64 / 3.0 + 2.0) * 12.5).ceil() as usize
}

// Text is tokenized in JavaScript, so the model's tokenizer is never used.
struct NoTokenizer;

impl ptts::Tokenizer for NoTokenizer {
    fn encode(&self, _text: &str) -> xn::Result<Vec<u32>> {
        Err(xn::Error::wrap(std::io::Error::other("tokenization happens in JavaScript")))
    }

    fn decode(&self, _tokens: &[u32]) -> xn::Result<String> {
        Err(xn::Error::wrap(std::io::Error::other("decoding happens in JavaScript")))
    }
}

// Gaussian noise with variance `temperature`, from a small deterministic generator, so the
// wrapper needs no OS randomness.
struct Gauss {
    state: u64,
    std: f32,
}

impl Gauss {
    fn new(seed: u64, temperature: f32) -> Self {
        Self { state: seed | 1, std: temperature.sqrt() }
    }

    fn uniform(&mut self) -> f64 {
        // xorshift64*
        self.state ^= self.state >> 12;
        self.state ^= self.state << 25;
        self.state ^= self.state >> 27;
        let v = self.state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        ((v >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
}

impl ptts::flow_lm::Rng for Gauss {
    fn sample(&mut self) -> f32 {
        let (u1, u2) = (self.uniform(), self.uniform());
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
        z as f32 * self.std
    }
}

struct Generation {
    state: TTSState<Q>,
    mimi: MimiDecoderState<f32, B>,
    prev_latent: Tensor<<Q as BackendQ>::T, B>,
    rng: Gauss,
    max_frames: usize,
    frames_after_eos: usize,
    eos_countdown: Option<usize>,
    step: usize,
    finished: bool,
}

#[wasm_bindgen]
pub struct Model {
    model: TTSModel<Q>,
    dev: B,
    ldim: usize,
    sample_rate: usize,
    voices: Vec<TTSState<Q>>,
    mimi_init: MimiDecoderState<f32, B>,
    generation: Option<Generation>,
    generations: u64,
}

#[wasm_bindgen]
impl Model {
    #[wasm_bindgen(constructor)]
    pub fn new(weights: &[u8], quant: &str) -> Result<Model, JsError> {
        if quant != "q8" {
            return Err(JsError::new("only the q8 weights are supported by this build"));
        }
        let cfg = TTSConfig::v202601(TEMPERATURE_DEFAULT);
        let dev = xn::CPU;
        let vb = VB::load_gguf_with_key_map(Cursor::new(weights.to_vec()), dev.clone(), remap_key)
            .map_err(js_err)?
            .root();
        let model = TTSModel::<Q>::load(&vb, Box::new(NoTokenizer), &cfg).map_err(js_err)?;
        let mimi_init = model.init_mimi_state(1, MIMI_CONTEXT).map_err(js_err)?;
        Ok(Model {
            sample_rate: model.sample_rate(),
            ldim: cfg.flow_lm.ldim,
            model,
            dev,
            voices: Vec::new(),
            mimi_init,
            generation: None,
            generations: 0,
        })
    }

    pub fn sample_rate(&self) -> usize {
        self.sample_rate
    }

    // Loads a voice (safetensors bytes): precomputed attention caches for each flow-LM layer,
    // `transformer.layers.{i}.self_attn/cache` [2, 1, T, heads, head_dim], plus the prompt length.
    pub fn add_voice(&mut self, data: &[u8]) -> Result<usize, JsError> {
        let vb = VB::from_bytes(vec![data.to_vec()], self.dev.clone()).map_err(js_err)?;
        let mut state = self.model.init_flow_lm_state(1, SEQ_BUDGET).map_err(js_err)?;
        for (i, layer) in state.flow_lm_state.transformer_state.layer_states.iter_mut().enumerate() {
            let key = format!("transformer.layers.{i}.self_attn/cache");
            let shape = vb.shape(&key).ok_or_else(|| JsError::new(&format!("voice is missing {key}")))?;
            let cache: Tensor<f32, B> = vb.tensor(&key, shape).map_err(js_err)?;
            let dims = cache.dims().to_vec();
            if dims.len() != 5 || dims[0] != 2 || dims[1] != 1 {
                return Err(JsError::new(&format!("unexpected voice cache shape {dims:?}")));
            }
            let prompt_len = dims[2];
            let (heads, head_dim) = (dims[3], dims[4]);
            let k = cache.narrow(0, 0..1).map_err(js_err)?.reshape((1, prompt_len, heads, head_dim)).map_err(js_err)?.contiguous().map_err(js_err)?;
            let v = cache.narrow(0, 1..2).map_err(js_err)?.reshape((1, prompt_len, heads, head_dim)).map_err(js_err)?.contiguous().map_err(js_err)?;
            match layer {
                LayerAttentionState::FlowLm(mha) => {
                    mha.k_cache.slice_set(&k.to::<<Q as BackendQ>::T>().map_err(js_err)?, 1usize, 0).map_err(js_err)?;
                    mha.v_cache.slice_set(&v.to::<<Q as BackendQ>::T>().map_err(js_err)?, 1usize, 0).map_err(js_err)?;
                    mha.current_end = prompt_len;
                }
                LayerAttentionState::Mimi(_) => return Err(JsError::new("unexpected mimi state in flow LM")),
            }
        }
        self.voices.push(state);
        Ok(self.voices.len() - 1)
    }

    // Returns [processedText, framesAfterEos] as a JavaScript array.
    pub fn prepare_text(&self, text: &str) -> JsValue {
        let (processed, frames_after_eos) = prepare_text_prompt(text);
        Array::of2(&JsValue::from_str(&processed), &JsValue::from_f64(frames_after_eos as f64)).into()
    }

    pub fn start_generation(
        &mut self,
        voice_index: usize,
        token_ids: &[u32],
        frames_after_eos: usize,
        temperature: f32,
    ) -> Result<(), JsError> {
        let mut state = self
            .voices
            .get(voice_index)
            .ok_or_else(|| JsError::new("unknown voice"))?
            .clone();
        self.model.prompt_text(&mut state, token_ids).map_err(js_err)?;
        let nan = vec![f32::NAN; self.ldim];
        let prev_latent = Tensor::from_vec(nan, (1, 1, self.ldim), &self.dev)
            .map_err(js_err)?
            .to::<<Q as BackendQ>::T>()
            .map_err(js_err)?;
        self.generations += 1;
        self.generation = Some(Generation {
            state,
            mimi: self.mimi_init.clone(),
            prev_latent,
            rng: Gauss::new(0x9E37_79B9_7F4A_7C15 ^ self.generations, temperature),
            max_frames: max_frames_for(token_ids.len()),
            frames_after_eos,
            eos_countdown: None,
            step: 0,
            finished: false,
        });
        Ok(())
    }

    // Returns the audio for the next latent frame, or undefined when the utterance is done.
    pub fn generation_step(&mut self) -> Result<Option<Vec<f32>>, JsError> {
        let run = match self.generation.as_mut() {
            Some(g) => g,
            None => return Ok(None),
        };
        if run.finished {
            self.generation = None;
            return Ok(None);
        }
        let (latent, is_eos) = self
            .model
            .generate_step(&mut run.state, &run.prev_latent, &mut run.rng)
            .map_err(js_err)?;
        let audio = self.model.decode_latent(&latent, &mut run.mimi).map_err(js_err)?;
        let samples = audio.flatten_all().map_err(js_err)?.to_vec1().map_err(js_err)?;

        // Same stopping rule as the ptts example: stop after the EOS countdown or the frame cap.
        if is_eos && run.eos_countdown.is_none() {
            run.eos_countdown = Some(run.frames_after_eos);
        }
        if let Some(countdown) = run.eos_countdown.as_mut() {
            if *countdown == 0 {
                run.finished = true;
            } else {
                *countdown -= 1;
            }
        }
        run.step += 1;
        if run.step >= run.max_frames {
            run.finished = true;
        }
        run.prev_latent = latent;
        Ok(Some(samples))
    }
}

#[wasm_bindgen]
pub fn cpu_features() -> String {
    format!("simd128={}", cfg!(target_feature = "simd128"))
}
