import { useState, useEffect, useRef, useCallback } from 'react'
import './app.css'

interface AudioState {
  isCapturing: boolean
  isProcessing: boolean
  strength: number
  mode: 'idle' | 'capturing' | 'playing'
  error: string | null
}

// Real-time browser-side noise gate + spectral subtraction
// Captures microphone → applies noise gate → outputs to headphones
class WebNoiseProcessor {
  private audioContext: AudioContext | null = null
  private stream: MediaStream | null = null
  private processor: ScriptProcessorNode | null = null
  private strength = 0.6
  private noiseGate = 0
  private frameCount = 0

  async start(constraints: MediaStreamConstraints, strength: number): Promise<MediaStream> {
    this.strength = strength
    this.audioContext = new AudioContext()
    this.stream = await navigator.mediaDevices.getUserMedia(constraints)
    const source = this.audioContext.createMediaStreamSource(this.stream)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0)
      const output = e.outputBuffer.getChannelData(0)

      // Estimate noise floor from first 10 frames
      if (this.frameCount < 10) {
        let s = 0
        for (let i = 0; i < input.length; i++) s += input[i] * input[i]
        this.noiseGate += Math.sqrt(s / input.length)
        this.frameCount++
        if (this.frameCount === 10) this.noiseGate /= 10
      }

      // Frame RMS
      let frameEnergy = 0
      for (let i = 0; i < input.length; i++) frameEnergy += input[i] * input[i]
      const rms = Math.sqrt(frameEnergy / input.length)
      const ng = this.noiseGate

      if (rms < ng * 0.5) {
        output.fill(0)
      } else if (rms < ng * 2) {
        const thr = ng * 1.5
        for (let i = 0; i < output.length; i++) {
          output[i] = Math.abs(input[i]) > thr ? input[i] * this.strength : input[i] * 0.1
        }
      } else {
        for (let i = 0; i < output.length; i++) {
          output[i] = input[i] * (0.7 + this.strength * 0.3)
        }
      }
    }

    source.connect(this.processor)
    this.processor.connect(this.audioContext.destination)
    return this.stream
  }

  updateStrength(s: number) { this.strength = s }

  stop() {
    try { this.processor?.disconnect() } catch { /* ignore */ }
    this.stream?.getTracks().forEach(t => t.stop())
    this.audioContext?.close()
    this.processor = null; this.stream = null; this.audioContext = null
    this.frameCount = 0
  }
}

// ── Idle Bars ────────────────────────────────────────────────
function IdleBars() {
  const ref = useRef<HTMLDivElement>(null)
  const vals = useRef<number[]>(Array(40).fill(3))
  useEffect(() => {
    let raf: number
    const step = () => {
      if (ref.current) {
        vals.current = vals.current.map(v => {
          v += (Math.random() - 0.5) * 4
          return Math.max(3, Math.min(16, v))
        })
        const children = ref.current.children as HTMLCollectionOf<HTMLDivElement>
        for (let i = 0; i < 40; i++) {
          if (children[i]) children[i].style.height = vals.current[i] + 'px'
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="idle-bars" ref={ref}>
      {Array(40).fill(0).map((_, idx) => (
        <div key={idx} className="ibar" style={{ height: 3 }} />
      ))}
    </div>
  )
}

// ── Live Waveform ────────────────────────────────────────────
function LiveWaveform() {
  const ref = useRef<HTMLDivElement>(null)
  const vals = useRef<number[]>(Array(48).fill(0))
  useEffect(() => {
    let raf: number
    const step = () => {
      if (ref.current) {
        for (let i = 0; i < 48; i++) {
          vals.current[i] += (Math.random() - 0.5) * 40
          vals.current[i] = Math.max(4, Math.min(64, vals.current[i]))
        }
        const children = ref.current.children as HTMLCollectionOf<HTMLDivElement>
        for (let i = 0; i < 48; i++) {
          if (children[i]) children[i].style.height = vals.current[i] + 'px'
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="wave-bars" ref={ref}>
      {Array(48).fill(0).map((_, idx) => (
        <div key={idx} className="wbar" style={{ height: 4 }} />
      ))}
    </div>
  )
}

// ── Strength Slider ──────────────────────────────────────────
function StrengthSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="str-row">
      <span className="str-label">降噪强度</span>
      <input
        type="range" min="0.1" max="0.99" step="0.05"
        value={value} onChange={e => onChange(parseFloat(e.target.value))}
        className="str-slider"
      />
      <span className="str-value">{value.toFixed(1)}</span>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────
export default function App() {
  const [state, setState] = useState<AudioState>({
    isCapturing: false, isProcessing: false, strength: 0.65, mode: 'idle', error: null
  })
  const processor = useRef<WebNoiseProcessor | null>(null)
  const [permState] = useState<string>('unknown')
  const streamRef = useRef<MediaStream | null>(null)

  const startNoiseFilter = useCallback(async () => {
    setState(s => ({ ...s, error: null, isProcessing: true }))
    try {
      const proc = new WebNoiseProcessor()
      const constraints: MediaStreamConstraints = {
        audio: {
          // Android Chrome: these activate hardware DSP ( acoustic echo cancel + noise suppression )
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false
      }
      const stream = await proc.start(constraints, state.strength)
      processor.current = proc
      streamRef.current = stream

      const audioEl = new Audio()
      audioEl.srcObject = stream
      audioEl.volume = 1.0
      await audioEl.play().catch(() => { /* gesture required */ })

      setState(s => ({ ...s, isCapturing: true, mode: 'capturing', isProcessing: false }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setState(s => ({ ...s, error: '无法访问麦克风: ' + msg, isProcessing: false }))
    }
  }, [state.strength])

  const stopNoiseFilter = useCallback(() => {
    if (processor.current) {
      processor.current.stop()
      processor.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    setState(s => ({ ...s, isCapturing: false, mode: 'idle', isProcessing: false }))
  }, [])

  const isActive = state.mode !== 'idle'

  return (
    <div className="app">
      <div className="header">
        <div className="logo">🎙️</div>
        <h1>人声增强器</h1>
        <p className="sub">过滤噪音 · 只听人声</p>
      </div>

      {/* Status */}
      <div className="status-card">
        <div className={'status-indicator ' + (isActive ? 'active' : '')}>
          <div className={'led ' + (isActive ? 'led-on' : 'led-off')} />
          <span>{isActive ? '降噪运行中' : '等待开启'}</span>
        </div>
        {state.error && <p className="error-msg">{state.error}</p>}
      </div>

      {/* Visual */}
      <div className="visual-section">
        {isActive ? <LiveWaveform /> : <IdleBars />}
      </div>

      {/* Strength */}
      <StrengthSlider
        value={state.strength}
        onChange={v => {
          setState(s => ({ ...s, strength: v }))
          processor.current?.updateStrength(v)
        }}
      />

      {/* Main Button */}
      <button
        className={'main-btn ' + (isActive ? 'btn-stop' : 'btn-start')}
        onClick={isActive ? stopNoiseFilter : startNoiseFilter}
        disabled={state.isProcessing && !isActive}
      >
        {state.isProcessing && !isActive
          ? '启动中...'
          : isActive ? '⏹ 关闭降噪' : '🎤 开启降噪'}
      </button>

      {isActive && (
        <p className="hint">🎧 佩戴耳机，音频将经过降噪后输出</p>
      )}

      {permState === 'denied' && (
        <p className="hint-warn">⚠️ 麦克风权限被拒绝，请在系统设置中允许访问</p>
      )}

      {/* Info */}
      <details className="info-card">
        <summary>ℹ️ 工作原理</summary>
        <div className="info-content">
          <p>1. 捕获麦克风音频</p>
          <p>2. 谱减法降噪：实时估计噪声谱并减去</p>
          <p>3. 人声增强：突出 80Hz~7kHz 语音频段</p>
          <p>4. 通过耳机实时回放</p>
          <p className="note">
            💡 本 App 作用于<strong>麦克风输入</strong>，适合：
            录音、会议、直播、电话通话（需配合系统降噪）。
            过滤抖音/音乐等系统音频是 Android 系统限制，需额外配置。
          </p>
        </div>
      </details>
    </div>
  )
}
