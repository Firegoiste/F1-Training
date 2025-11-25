
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

// --- TYPES ---
type Weather = 'dry' | 'cloudy' | 'wet' | null;
type TyreCompound = 'hard' | 'medium' | 'soft' | 'inter' | 'wet' | null;

interface SystemDetail {
  done: boolean;
  note: string;
  value: number; // Added metric tracking (e.g., mins, count, cals)
}

interface DailyData {
  date: string;
  weather: Weather;
  tyre: TyreCompound;
  tyreLaps: number; // Duration in minutes/laps
  systems: {
    simulator: SystemDetail; // English
    fuel: SystemDetail;      // Diet
    cooling: SystemDetail;   // Mindfulness
  };
  ers: number;          // Sleep hours
  debrief: string;      // Notes
}

const STORAGE_KEY = 'f1_telemetry_v3';

// --- UTILS ---
const getTodayStr = () => new Date().toISOString().split('T')[0];

const INITIAL_SYSTEM_DETAIL: SystemDetail = { done: false, note: '', value: 0 };

const INITIAL_STATE: DailyData = {
  date: getTodayStr(),
  weather: null,
  tyre: null,
  tyreLaps: 0,
  systems: {
    simulator: { ...INITIAL_SYSTEM_DETAIL },
    fuel: { ...INITIAL_SYSTEM_DETAIL },
    cooling: { ...INITIAL_SYSTEM_DETAIL },
  },
  ers: 0,
  debrief: ''
};

// --- AUDIO & HAPTIC ENGINE ---
const SoundFX = {
  ctx: null as AudioContext | null,
  init: () => {
    if (!SoundFX.ctx) {
      SoundFX.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (SoundFX.ctx.state === 'suspended') {
      SoundFX.ctx.resume();
    }
    return SoundFX.ctx;
  },
  play: (type: 'click' | 'save' | 'box' | 'radio_on' | 'radio_off') => {
    // Haptics
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
        if (type === 'click') navigator.vibrate(8); 
        if (type === 'save') navigator.vibrate(15);
        if (type === 'box') navigator.vibrate([50, 50, 50]);
        if (type === 'radio_on') navigator.vibrate(10);
    }

    // Audio
    const ctx = SoundFX.init();
    if (!ctx) return;
    
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, t);
      osc.frequency.exponentialRampToValueAtTime(1200, t + 0.05);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.start(t);
      osc.stop(t + 0.05);
    } else if (type === 'save') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(200, t);
      osc.frequency.linearRampToValueAtTime(600, t + 0.15);
      gain.gain.setValueAtTime(0.02, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.15);
    } else if (type === 'box') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(100, t);
      osc.frequency.exponentialRampToValueAtTime(400, t + 0.4);
      gain.gain.setValueAtTime(0.1, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.4);
      osc.start(t);
      osc.stop(t + 0.4);
    } else if (type === 'radio_on') {
      // Radio squelch open
      const bufferSize = ctx.sampleRate * 0.1; 
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.05;
      noise.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noise.start(t);
      
      // Beep
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2000, t);
      osc.frequency.setValueAtTime(0, t + 0.1);
      gain.gain.setValueAtTime(0.05, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.1);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }
};

// --- COMPONENTS ---

const BufferedNumberInput = ({ 
    value, 
    onChange, 
    placeholder, 
    className 
}: { 
    value: number, 
    onChange: (v: number) => void, 
    placeholder: string, 
    className: string 
}) => {
    const [localVal, setLocalVal] = useState(value === 0 ? '' : value.toString());

    useEffect(() => {
        setLocalVal(value === 0 ? '' : value.toString());
    }, [value]);

    return (
        <input
            type="number"
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={() => onChange(parseFloat(localVal) || 0)}
            placeholder={placeholder}
            className={className}
        />
    )
}

const BufferedTextInput = ({ 
    value, 
    onChange, 
    placeholder, 
    className 
}: { 
    value: string, 
    onChange: (v: string) => void, 
    placeholder: string, 
    className: string 
}) => {
    const [localVal, setLocalVal] = useState(value);

    // Only update local state if external value changes and is different (e.g., loaded from history)
    // We avoid aggressive syncing to prevent cursor jumping
    useEffect(() => {
        if (value !== localVal) {
            setLocalVal(value);
        }
    }, [value]);

    return (
        <input
            type="text"
            value={localVal}
            onChange={(e) => setLocalVal(e.target.value)}
            onBlur={() => onChange(localVal)}
            placeholder={placeholder}
            className={className}
        />
    )
}

const Header = ({ title, subtitle }: { title: string; subtitle: string }) => (
  <header className="flex justify-between items-end border-b-2 border-[#E10600] pb-2 mb-6 px-4 pt-4 sticky top-0 bg-[#15151E]/95 backdrop-blur-md z-30 transition-all duration-500 ease-spring">
    <div>
      <h1 className="text-3xl font-bold tracking-tighter italic uppercase text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
        {title}
      </h1>
      <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">{subtitle}</p>
    </div>
    <div className="flex flex-col items-end">
      <div className="flex gap-1 items-center">
        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
        <span className="text-[10px] text-green-500 font-bold tracking-wider">LIVE TIMING</span>
      </div>
      <span className="text-2xl font-mono font-bold text-[#E10600] drop-shadow-[0_0_8px_rgba(225,6,0,0.5)]">{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  </header>
);

const TelemetrySection = ({ title, children, className = '', style }: { title: string, children?: React.ReactNode, className?: string, style?: React.CSSProperties }) => (
  <section className={`mb-8 px-4 animate-in slide-in-from-bottom-4 fade-in duration-700 fill-mode-backwards ${className}`} style={style}>
    <div className="flex items-center gap-2 mb-4 group">
      <div className="w-1 h-5 bg-[#E10600] skew-f1 group-hover:shadow-[0_0_10px_rgba(225,6,0,0.8)] transition-all duration-300"></div>
      <h2 className="text-base font-bold text-gray-200 uppercase tracking-wider">{title}</h2>
      <div className="flex-grow h-[1px] bg-gradient-to-r from-gray-700 to-transparent ml-2 opacity-50"></div>
    </div>
    {children}
  </section>
);

const TrackConditions = ({ value, onChange }: { value: Weather, onChange: (v: Weather) => void }) => {
  const options: { id: Weather; label: string; icon: string; color: string }[] = [
    { id: 'dry', label: '干地 (极佳)', icon: '☀️', color: 'text-yellow-400' },
    { id: 'cloudy', label: '多云 (一般)', icon: '☁️', color: 'text-gray-400' },
    { id: 'wet', label: '湿地 (低落)', icon: '🌧️', color: 'text-blue-400' },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => { onChange(opt.id); SoundFX.play('click'); }}
          className={`
            relative p-3 border-l-2 bg-[#1E1E28] flex flex-col items-center justify-center transition-all duration-300 ease-spring transform
            hover:scale-[1.02] active:scale-95
            ${value === opt.id 
              ? 'border-[#E10600] bg-[#2A2A35] shadow-[0_0_20px_rgba(225,6,0,0.2)]' 
              : 'border-gray-700 opacity-60 hover:opacity-100'}
          `}
        >
          <span className="text-3xl mb-2 filter drop-shadow-lg">{opt.icon}</span>
          <span className={`text-xs uppercase font-bold tracking-tight ${value === opt.id ? 'text-white' : 'text-gray-500'}`}>{opt.label}</span>
          {value === opt.id && <div className="absolute top-1 right-1 w-2 h-2 bg-[#E10600] rounded-full shadow-[0_0_5px_#E10600]"></div>}
        </button>
      ))}
    </div>
  );
};

const TyreStrategy = ({ 
  tyre, 
  laps, 
  onTyreChange, 
  onLapsChange 
}: { 
  tyre: TyreCompound, 
  laps: number, 
  onTyreChange: (v: TyreCompound) => void,
  onLapsChange: (v: number) => void
}) => {
  const tyres: { id: TyreCompound; label: string; desc: string; borderColor: string; color: string }[] = [
    { id: 'hard', label: 'HARD', desc: '步行', borderColor: 'border-white', color: 'text-white' },
    { id: 'medium', label: 'MED', desc: '跑步', borderColor: 'border-yellow-400', color: 'text-yellow-400' },
    { id: 'soft', label: 'SOFT', desc: '搏击', borderColor: 'border-red-500', color: 'text-red-500' },
    { id: 'inter', label: 'INTER', desc: '力量', borderColor: 'border-green-500', color: 'text-green-500' },
    { id: 'wet', label: 'WET', desc: '游泳', borderColor: 'border-blue-500', color: 'text-blue-500' },
  ];

  return (
    <div className="bg-[#1E1E28] border border-gray-800 p-4 pt-6 rounded-lg relative overflow-hidden group hover:border-gray-700 transition-colors duration-500">
      {/* Centered Watermark */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
          <span className="text-[80px] font-bold text-white opacity-[0.03] leading-none select-none whitespace-nowrap transition-opacity duration-500 group-hover:opacity-[0.05]">
            PIRELLI
          </span>
      </div>

      <div className="flex justify-between gap-2 overflow-x-auto pb-4 pt-6 scrollbar-hide relative z-10">
        {tyres.map((t) => {
          const isSelected = tyre === t.id;
          return (
            <button
              key={t.id}
              onClick={() => { onTyreChange(t.id); SoundFX.play('click'); }}
              className="flex-shrink-0 flex flex-col items-center w-14 group/tyre relative z-10 active:scale-95 transition-transform duration-200"
            >
              <div className={`
                w-12 h-12 rounded-full border-[3px] flex items-center justify-center bg-[#15151E] transition-all duration-300 ease-spring
                ${t.borderColor} ${isSelected ? 'scale-110 shadow-[0_0_15px_rgba(255,255,255,0.3)]' : 'opacity-40 grayscale group-hover/tyre:grayscale-0 group-hover/tyre:opacity-80'}
              `}>
                <span className={`text-[10px] font-bold ${t.color}`}>{t.label[0]}</span>
              </div>
              <span className={`mt-2 text-[9px] uppercase font-bold tracking-tighter transition-colors duration-300 ${isSelected ? t.color : 'text-gray-600'}`}>{t.desc}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-4 flex items-center gap-4 border-t border-gray-700 pt-4 relative z-10">
        <div className="text-xs font-bold text-gray-400 uppercase w-24 leading-tight">Stint Length<br/>(Mins/Laps)</div>
        <div className="flex-grow flex items-center bg-[#15151E] border border-gray-600 rounded px-3 h-10 skew-f1 focus-within:border-[#E10600] focus-within:shadow-[0_0_10px_rgba(225,6,0,0.2)] transition-all duration-300 ease-spring">
            <BufferedNumberInput 
              value={laps || 0} 
              onChange={onLapsChange}
              placeholder="0"
              className="w-full bg-transparent text-white font-mono text-lg outline-none unskew-f1 text-right placeholder-gray-700"
            />
            <span className="text-gray-500 text-xs font-bold ml-2 unskew-f1">LAPS</span>
        </div>
      </div>
    </div>
  );
};

const SystemsCheck = ({ 
  systems, 
  onChange,
  onNoteChange,
  onValueChange
}: { 
  systems: DailyData['systems'], 
  onChange: (key: keyof DailyData['systems']) => void,
  onNoteChange: (key: keyof DailyData['systems'], note: string) => void,
  onValueChange: (key: keyof DailyData['systems'], value: number) => void
}) => {
  const items = [
    { key: 'simulator', label: '模拟器训练', sub: 'English', placeholder: '今日学习内容...', unit: '词/Words' },
    { key: 'fuel', label: '燃油加注', sub: 'Clean Diet', placeholder: '今日摄入餐食...', unit: '卡/Kcal' },
    { key: 'cooling', label: '冷却系统', sub: 'Mindfulness', placeholder: '冥想或放松方式...', unit: '分/Mins' },
  ];

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const key = item.key as keyof typeof systems;
        const data = systems[key];
        const isActive = data.done;

        return (
          <div key={item.key} className="bg-[#1E1E28] border-l-2 border-gray-700 overflow-hidden transition-all duration-300 ease-spring">
            {/* Header / Toggle */}
            <button
              onClick={() => { onChange(key); SoundFX.play('click'); }}
              className="w-full flex items-center justify-between p-3 transition-all duration-300 group hover:bg-[#2A2A35] hover:shadow-[inset_0_0_20px_rgba(225,6,0,0.15)] hover:border-l-[#E10600] active:bg-[#2A2A35]"
            >
              <div className="text-left">
                <div className="text-sm font-bold text-gray-200 group-hover:text-white transition-colors">{item.label}</div>
                <div className="text-[10px] text-gray-500 uppercase font-bold tracking-wider group-hover:text-gray-400">{item.sub}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-mono font-bold transition-all duration-300 ${isActive ? 'text-green-500 drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]' : 'text-red-500 opacity-50'}`}>
                  {isActive ? 'NOMINAL' : 'OFFLINE'}
                </span>
                <div className={`
                  w-10 h-5 rounded-full p-1 transition-all duration-300 ease-spring
                  ${isActive ? 'bg-green-900 shadow-[0_0_10px_rgba(34,197,94,0.3)]' : 'bg-gray-800'}
                `}>
                  <div className={`
                    w-3 h-3 rounded-full bg-white shadow-md transform transition-transform duration-300 ease-spring
                    ${isActive ? 'translate-x-5' : 'translate-x-0'}
                  `}></div>
                </div>
              </div>
            </button>

            {/* Expandable Note & Value Input */}
            <div className={`
              bg-[#15151E] border-t border-gray-800 transition-all duration-500 ease-spring flex flex-col gap-2
              ${isActive ? 'max-h-32 opacity-100 p-3' : 'max-h-0 opacity-0 p-0 overflow-hidden'}
            `}>
              <div className="flex gap-3">
                  {/* Numeric Input */}
                  <div className="w-1/3 min-w-[80px]">
                     <div className="relative border border-gray-600 rounded bg-black/20 focus-within:border-[#E10600] transition-colors">
                        <BufferedNumberInput
                            value={data.value || 0}
                            onChange={(val) => onValueChange(key, val)}
                            className="w-full bg-transparent text-white font-mono text-sm p-2 outline-none text-center z-10 relative"
                            placeholder="0"
                        />
                        <div className="absolute right-1 bottom-0.5 text-[8px] text-gray-500 font-bold uppercase pointer-events-none">{item.unit}</div>
                     </div>
                  </div>

                  {/* Text Input */}
                  <div className="flex-grow flex items-center gap-2 border-b border-gray-800 pb-1 focus-within:border-[#E10600] transition-colors">
                    <span className="text-[#E10600] text-xs font-mono">>></span>
                    <BufferedTextInput
                      value={data.note}
                      onChange={(val) => onNoteChange(key, val)}
                      placeholder={item.placeholder}
                      className="w-full bg-transparent text-sm text-gray-300 placeholder-gray-700 outline-none"
                    />
                  </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const ERSDisplay = ({ value, onChange }: { value: number, onChange: (v: number) => void }) => {
  const percentage = (value / 12) * 100;
  const barColor = value >= 7 ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : value >= 5 ? 'bg-yellow-500' : 'bg-red-500';
  
  return (
    <div className="bg-[#1E1E28] p-4 border border-gray-800 rounded relative group hover:border-gray-700 transition-colors duration-300 ease-spring">
       <div className="absolute top-2 right-2 flex gap-1">
          <div className="w-1 h-1 bg-white rounded-full"></div>
          <div className="w-1 h-1 bg-white rounded-full opacity-50"></div>
          <div className="w-1 h-1 bg-white rounded-full opacity-25"></div>
       </div>

      <div className="flex justify-between mb-2 font-mono text-xs items-end">
        <span className="text-gray-400 font-bold tracking-wider">BATTERY CHARGE</span>
        <span className={`text-xl font-bold transition-colors duration-300 ${value >= 7 ? 'text-green-500' : 'text-yellow-500'}`}>{value}<span className="text-xs ml-1 text-gray-500">HOURS</span></span>
      </div>
      
      <div className="relative h-8 bg-black border border-gray-600 mb-6 skew-f1 overflow-hidden">
        <div className="absolute inset-0 flex justify-between px-1 z-10 pointer-events-none">
            {[...Array(11)].map((_, i) => <div key={i} className="w-[1px] h-full bg-gray-800"></div>)}
        </div>
        
        <div 
          className={`absolute top-0 left-0 h-full ${barColor} transition-all duration-500 ease-spring`} 
          style={{ width: `${percentage}%` }}
        >
          <div className="w-full h-full opacity-40" style={{ backgroundImage: 'linear-gradient(45deg,rgba(0,0,0,.3) 25%,transparent 25%,transparent 50%,rgba(0,0,0,.3) 50%,rgba(0,0,0,.3) 75%,transparent 75%,transparent)', backgroundSize: '0.5rem 0.5rem' }}></div>
        </div>
      </div>

      <input
        type="range"
        min="0"
        max="12"
        step="0.5"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full relative z-20"
      />
      <div className="flex justify-between text-[10px] text-gray-600 font-mono mt-2 uppercase font-bold">
        <span>Empty (0h)</span>
        <span>Optimal (12h)</span>
      </div>
    </div>
  );
};

const TeamRadioGraphic = ({ text, onClose }: { text: string | null, onClose: () => void }) => {
    const [visible, setVisible] = useState(false);
    
    useEffect(() => {
        if (text) {
            setVisible(true);
            SoundFX.play('radio_on');
        } else {
            const timer = setTimeout(() => setVisible(false), 500); // Wait for exit anim
            return () => clearTimeout(timer);
        }
    }, [text]);

    if (!visible) return null;

    return (
        <div className={`fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 transition-all duration-500 ease-spring ${text ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'}`}>
            <div className="bg-black/90 border-l-4 border-[#E10600] w-full max-w-lg shadow-[0_10px_50px_rgba(0,0,0,0.8)] overflow-hidden backdrop-blur-md rounded-r-lg">
                 {/* Header */}
                 <div className="bg-white px-4 py-1 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-[#E10600] rounded-full animate-pulse"></div>
                        <span className="text-black font-bold font-mono text-xs tracking-widest uppercase">Team Radio</span>
                    </div>
                    <span className="text-black font-bold font-mono text-xs uppercase">RACE ENGINEER</span>
                 </div>
                 
                 {/* Content */}
                 <div className="p-4 flex items-center gap-4">
                    {/* Fake Waveform */}
                    <div className="flex gap-0.5 items-center h-8 flex-shrink-0">
                        {[...Array(8)].map((_, i) => (
                            <div key={i} className="w-1 bg-[#E10600] animate-pulse" style={{ height: `${Math.random() * 100}%`, animationDuration: `${0.2 + Math.random() * 0.3}s` }}></div>
                        ))}
                    </div>
                    
                    <p className="text-white font-mono text-sm leading-tight font-bold typing-effect">
                        {text}
                    </p>
                 </div>
                 
                 <button onClick={onClose} className="w-full bg-[#15151E] text-gray-500 text-[10px] py-1 hover:text-white uppercase tracking-widest transition-colors">
                    Dismiss
                 </button>
            </div>
        </div>
    )
}

const ConfirmationToast = ({ show }: { show: boolean }) => {
    if (!show) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
             <div className="bg-[#15151E]/80 absolute inset-0 backdrop-blur-sm animate-in fade-in duration-300"></div>
             <div className="relative animate-scale-in">
                 <div className="bg-green-600 text-white px-8 py-4 font-bold font-mono skew-f1 shadow-[0_20px_50px_rgba(0,0,0,0.5)] flex items-center gap-4 border-2 border-white scale-125">
                    <span className="text-3xl">🏁</span>
                    <div>
                        <div className="unskew-f1 text-2xl tracking-tighter italic">PIT STOP COMPLETE</div>
                        <div className="unskew-f1 text-xs opacity-75 uppercase tracking-widest">Data Secured</div>
                    </div>
                 </div>
             </div>
        </div>
    )
}

const App = () => {
  const [currentView, setCurrentView] = useState<'telemetry' | 'history'>('telemetry');
  const [data, setData] = useState<DailyData>(INITIAL_STATE);
  const [history, setHistory] = useState<Record<string, DailyData>>({});
  const [modalData, setModalData] = useState<DailyData | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [radioMessage, setRadioMessage] = useState<string | null>(null);
  
  // History Filter States
  const [historyFilter, setHistoryFilter] = useState<'all' | 'purple' | 'yellow' | 'dnf'>('all');
  const [historySort, setHistorySort] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsedHistory = JSON.parse(saved);
        setHistory(parsedHistory);
        
        const todayStr = getTodayStr();
        if (parsedHistory[todayStr]) {
            // Merge deep structure to avoid undefined errors on new properties
          const merged = { 
            ...INITIAL_STATE, 
            ...parsedHistory[todayStr],
            systems: {
                simulator: { ...INITIAL_SYSTEM_DETAIL, ...parsedHistory[todayStr].systems?.simulator },
                fuel: { ...INITIAL_SYSTEM_DETAIL, ...parsedHistory[todayStr].systems?.fuel },
                cooling: { ...INITIAL_SYSTEM_DETAIL, ...parsedHistory[todayStr].systems?.cooling },
            }
          };
          setData(merged);
        }
      } catch (e) {
        console.error("Data migration error", e);
      }
    }
  }, []);

  const handleSave = () => {
    SoundFX.play('box');
    const todayStr = getTodayStr();
    const newData = { ...data, date: todayStr };
    const newHistory = { ...history, [todayStr]: newData };
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
    setHistory(newHistory);
    
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2000);
  };

  const generateDebrief = async () => {
    if (!process.env.API_KEY) {
        setRadioMessage("无线电检查失败：缺少API Key。");
        return;
    }
    
    SoundFX.play('save'); 
    setIsGenerating(true);
    setRadioMessage(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        const systemPrompt = `你是一级方程式赛车工程师（类似于 Peter Bonnington 或 Gianpiero Lambiase）。
        请分析车手的每日遥测数据。
        
        输入数据:
        - 天气: ${data.weather === 'dry' ? '干地' : data.weather === 'wet' ? '湿地' : '多云'}
        - 轮胎: ${data.tyre} (时长: ${data.tyreLaps} 分钟)
        - 模拟器 (英语): ${data.systems.simulator.done ? '通过' : '未通过'} (${data.systems.simulator.value} 词)
        - 燃油 (饮食): ${data.systems.fuel.done ? '通过' : '未通过'} (${data.systems.fuel.value} 千卡)
        - 冷却 (冥想): ${data.systems.cooling.done ? '通过' : '未通过'} (${data.systems.cooling.value} 分钟)
        - ERS (睡眠): ${data.ers} 小时
        
        输出要求:
        请用中文输出一段简短有力的车队无线电 (Team Radio) 消息。
        像真正的比赛工程师一样说话。
        如果表现好（绿色指标多，睡眠充足，有运动），给予鼓励（例如：“第一赛段刷紫，节奏很好”）。
        如果错过任务，表示紧迫感但要支持（例如：“我们在弯道损失了时间，专注当下，低下头 (Head down)”）。
        不要超过50个字。
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: systemPrompt }] }]
        });

        const text = response.text;
        if (text) {
            setData(prev => ({ ...prev, debrief: prev.debrief + (prev.debrief ? '\n\n' : '') + `[工程师]: ${text}` }));
            setRadioMessage(text);
        }
    } catch (e) {
        console.error(e);
        setRadioMessage("无线电干扰。连接断开。");
    } finally {
        setIsGenerating(false);
    }
  };

  const calculatePerformance = (entry: DailyData) => {
    // New rule: If no Tyre selected (no exercise), it is DNF.
    if (!entry.tyre) return 'dnf';

    const checks = [
      entry.systems.simulator.done,
      entry.systems.fuel.done,
      entry.systems.cooling.done,
      !!entry.tyre,
      !!entry.weather,
      entry.ers >= 6
    ];
    const score = checks.filter(Boolean).length;
    
    if (score === 6) return 'purple'; 
    if (score >= 3) return 'yellow'; 
    return 'gray'; // Completed but poor performance
  };

  const getCellColor = (type: string) => {
    switch(type) {
      case 'purple': return 'bg-purple-600 border-purple-400 shadow-[0_0_10px_rgba(147,51,234,0.5)]';
      case 'yellow': return 'bg-yellow-500 border-yellow-300 text-black shadow-[0_0_10px_rgba(234,179,8,0.5)]';
      case 'gray': return 'bg-gray-700 border-gray-500';
      case 'dnf': return 'bg-neutral-900 border-gray-800 opacity-60 bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,#000_5px,#000_10px)]';
      default: return 'bg-[#1E1E28] border-gray-800 opacity-30';
    }
  };

  const TelemetryView = () => (
    <div className="pb-40">
      <TelemetrySection title="赛道状况 / Track Conditions" style={{ animationDelay: '0ms' }}>
        <TrackConditions 
          value={data.weather} 
          onChange={(v) => setData({ ...data, weather: v })} 
        />
      </TelemetrySection>

      <TelemetrySection title="轮胎策略 / Tyre Strategy" style={{ animationDelay: '100ms' }}>
        <TyreStrategy 
          tyre={data.tyre} 
          laps={data.tyreLaps}
          onTyreChange={(v) => setData({ ...data, tyre: v })}
          onLapsChange={(v) => setData({ ...data, tyreLaps: v })} 
        />
      </TelemetrySection>

      <TelemetrySection title="系统自检 / Systems Check" style={{ animationDelay: '200ms' }}>
        <SystemsCheck 
          systems={data.systems}
          onChange={(key) => setData({ ...data, systems: { ...data.systems, [key]: { ...data.systems[key], done: !data.systems[key].done } } })}
          onNoteChange={(key, note) => setData({ ...data, systems: { ...data.systems, [key]: { ...data.systems[key], note } } })}
          onValueChange={(key, val) => setData({ ...data, systems: { ...data.systems, [key]: { ...data.systems[key], value: val } } })}
        />
      </TelemetrySection>

      <TelemetrySection title="能量回收 / ERS (Sleep)" style={{ animationDelay: '300ms' }}>
        <ERSDisplay 
          value={data.ers} 
          onChange={(v) => setData({ ...data, ers: v })} 
        />
      </TelemetrySection>

      <TelemetrySection title="赛后总结 / Race Debrief" style={{ animationDelay: '400ms' }}>
        <div className="relative group">
            <textarea
            value={data.debrief}
            onChange={(e) => setData({ ...data, debrief: e.target.value })}
            placeholder="等待车手输入..."
            className="w-full h-32 bg-[#1E1E28] border border-gray-700 p-4 text-sm text-white focus:border-[#E10600] focus:shadow-[0_0_15px_rgba(225,6,0,0.1)] outline-none font-mono leading-relaxed resize-none transition-all duration-300 ease-spring"
            ></textarea>
            
            <button 
                onClick={generateDebrief}
                disabled={isGenerating}
                className="absolute bottom-2 right-2 bg-[#2A2A35] hover:bg-gray-700 border border-gray-600 px-3 py-1 text-xs font-bold text-gray-300 flex items-center gap-2 transition-all duration-300 disabled:opacity-50 hover:text-white"
            >
                {isGenerating ? (
                    <span className="animate-pulse text-[#E10600]">正在连接指挥台...</span>
                ) : (
                    <>
                        <span>📻 无线电检查 / RADIO CHECK</span>
                    </>
                )}
            </button>
        </div>
      </TelemetrySection>
    </div>
  );

  const HistoryView = () => {
    // Generate dates based on sort order
    const dayKeys = useMemo(() => {
        const keys = [];
        for (let i = 0; i < 30; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            keys.push(d.toISOString().split('T')[0]);
        }
        return historySort === 'asc' ? keys.reverse() : keys;
    }, [historySort]);

    return (
      <div className="px-4 pb-32 animate-in slide-in-from-right duration-500 ease-spring">
        {/* Controls */}
        <div className="flex justify-between items-center mb-4 bg-[#1E1E28] p-2 rounded border border-gray-800">
            <div className="flex gap-2">
                 {(['all', 'purple', 'yellow', 'dnf'] as const).map(f => (
                     <button
                        key={f}
                        onClick={() => { setHistoryFilter(f); SoundFX.play('click'); }}
                        className={`text-[10px] font-bold uppercase px-2 py-1 rounded transition-colors ${historyFilter === f ? 'bg-[#E10600] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                     >
                        {f === 'purple' ? 'Fastest' : f === 'yellow' ? 'Points' : f.toUpperCase()}
                     </button>
                 ))}
            </div>
            <button 
                onClick={() => { setHistorySort(s => s === 'desc' ? 'asc' : 'desc'); SoundFX.play('click'); }}
                className="text-xs text-gray-400 font-mono"
            >
                {historySort === 'desc' ? '⬇ Date' : '⬆ Date'}
            </button>
        </div>

        <div className="grid grid-cols-5 gap-3">
          {dayKeys.map((dStr, index) => {
            const entry = history[dStr];
            const hasData = !!entry;
            const perf = hasData ? calculatePerformance(entry) : 'empty';
            
            // Filter Logic
            if (historyFilter !== 'all') {
                if (historyFilter === 'purple' && perf !== 'purple') return null;
                if (historyFilter === 'yellow' && perf !== 'yellow') return null;
                if (historyFilter === 'dnf' && perf !== 'dnf') return null;
            }

            const dayNum = dStr.split('-')[2];
            const monthNum = dStr.split('-')[1];
            
            const simDone = entry?.systems?.simulator?.done;
            const fuelDone = entry?.systems?.fuel?.done;
            const coolingDone = entry?.systems?.cooling?.done;

            return (
              <button
                key={dStr}
                onClick={() => { if(hasData) { setModalData(entry); SoundFX.play('click'); } }}
                className={`
                  aspect-square border flex flex-col items-center justify-center relative rounded-sm transition-transform active:scale-95 ease-spring
                  ${getCellColor(perf)}
                  ${!hasData ? 'cursor-default' : 'hover:scale-105'}
                `}
                style={{ animationDelay: `${index * 15}ms` }}
              >
                <span className="text-[10px] opacity-50 absolute top-0.5 left-1">{monthNum}/</span>
                <span className="text-sm font-bold">{dayNum}</span>
                
                {hasData && perf !== 'dnf' && (
                  <div className="flex gap-[2px] mt-1 absolute bottom-1.5">
                    <div className={`w-1 h-1 rounded-full ${simDone ? 'bg-white' : 'bg-black/30'}`} title="English"></div>
                    <div className={`w-1 h-1 rounded-full ${fuelDone ? 'bg-white' : 'bg-black/30'}`} title="Diet"></div>
                    <div className={`w-1 h-1 rounded-full ${coolingDone ? 'bg-white' : 'bg-black/30'}`} title="Mindfulness"></div>
                  </div>
                )}
                
                {perf === 'dnf' && <span className="absolute bottom-1 text-[8px] font-bold text-gray-500">DNF</span>}
                {perf === 'purple' && <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div>}
              </button>
            )
          })}
        </div>
        
        <div className="mt-8 space-y-3 text-xs font-bold text-gray-400 uppercase tracking-wide">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 bg-purple-600 border border-purple-400 shadow-[0_0_5px_rgba(147,51,234,0.5)]"></div>
            <span>最快圈速 (全勤) / Fastest Lap</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 bg-yellow-500 border border-yellow-300 text-black flex items-center justify-center"></div>
            <span>积分完赛 (部分) / Points Finish</span>
          </div>
           <div className="flex items-center gap-3">
            <div className="w-4 h-4 bg-neutral-900 border border-gray-600 bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,#333_2px,#333_4px)]"></div>
            <span>未完赛 (无训练) / DNF</span>
          </div>
        </div>
      </div>
    );
  };

  const Modal = () => {
    if (!modalData) return null;
    return (
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-300 ease-spring" onClick={() => setModalData(null)}>
        <div className="bg-[#15151E] border-2 border-[#E10600] w-full max-w-sm relative shadow-[0_0_50px_rgba(225,6,0,0.2)] scale-100 animate-scale-in" onClick={e => e.stopPropagation()}>
          <div className="bg-[#E10600] text-white px-4 py-2 flex justify-between items-center">
            <h3 className="text-lg font-bold italic uppercase tracking-tighter">赛后分析 / Post-Race</h3>
            <button onClick={() => setModalData(null)} className="font-mono hover:text-black transition-colors">✕</button>
          </div>
          
          <div className="p-6 space-y-5 font-mono text-sm max-h-[70vh] overflow-y-auto">
            <div className="text-center border-b border-gray-800 pb-4">
                <div className="text-2xl font-bold text-white mb-1">{modalData.date}</div>
                <div className="text-xs text-gray-500 uppercase tracking-widest">大奖赛日期 / Grand Prix Date</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-[#1E1E28] p-2 text-center border border-gray-700 rounded">
                    <div className="text-[10px] text-gray-500">条件 / CONDITIONS</div>
                    <div className="text-white font-bold">{modalData.weather === 'dry' ? '干地' : modalData.weather === 'wet' ? '湿地' : modalData.weather === 'cloudy' ? '多云' : 'N/A'}</div>
                </div>
                <div className="bg-[#1E1E28] p-2 text-center border border-gray-700 rounded">
                    <div className="text-[10px] text-gray-500">策略 / STRATEGY</div>
                    <div className="text-yellow-400 font-bold uppercase">{modalData.tyre || 'NO START'}</div>
                    <div className="text-[10px] text-gray-500">{modalData.tyreLaps} LAPS</div>
                </div>
            </div>

             <div className="space-y-2">
                <div className="text-xs text-[#E10600] font-bold uppercase border-b border-gray-800 pb-1">系统报告 / Systems Report</div>
                <div className="flex justify-between items-center">
                    <span className="text-gray-400">English ({modalData.systems.simulator.value})</span>
                    <span className={modalData.systems.simulator.done ? "text-green-500" : "text-red-500"}>
                        {modalData.systems.simulator.done ? "PASS" : "FAIL"}
                    </span>
                </div>
                {modalData.systems.simulator.note && <div className="text-xs text-gray-500 pl-2 border-l border-gray-700">{modalData.systems.simulator.note}</div>}

                <div className="flex justify-between items-center">
                    <span className="text-gray-400">Diet ({modalData.systems.fuel.value})</span>
                    <span className={modalData.systems.fuel.done ? "text-green-500" : "text-red-500"}>
                        {modalData.systems.fuel.done ? "PASS" : "FAIL"}
                    </span>
                </div>
                {modalData.systems.fuel.note && <div className="text-xs text-gray-500 pl-2 border-l border-gray-700">{modalData.systems.fuel.note}</div>}

                <div className="flex justify-between items-center">
                    <span className="text-gray-400">Mindfulness ({modalData.systems.cooling.value})</span>
                    <span className={modalData.systems.cooling.done ? "text-green-500" : "text-red-500"}>
                        {modalData.systems.cooling.done ? "PASS" : "FAIL"}
                    </span>
                </div>
                {modalData.systems.cooling.note && <div className="text-xs text-gray-500 pl-2 border-l border-gray-700">{modalData.systems.cooling.note}</div>}
            </div>
            
            <div className="bg-[#1E1E28] p-4 border-l-2 border-[#E10600] rounded-r">
              <p className="text-[10px] text-gray-400 mb-2 uppercase tracking-widest font-bold">车手简报 / Driver's Debrief:</p>
              <p className="text-white whitespace-pre-wrap leading-relaxed">{modalData.debrief || 'No telemetry notes.'}</p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#15151E] text-white overflow-x-hidden selection:bg-[#E10600] selection:text-white pb-safe">
      <ConfirmationToast show={showToast} />
      <TeamRadioGraphic text={radioMessage} onClose={() => setRadioMessage(null)} />
      
      <Header title="驾驶舱" subtitle="Cockpit Telemetry V3.0" />
      
      {currentView === 'telemetry' ? <TelemetryView /> : <HistoryView />}

      <div className="fixed bottom-0 left-0 w-full bg-[#15151E]/95 backdrop-blur border-t-2 border-[#E10600] p-4 pb-6 z-40 shadow-[0_-10px_40px_rgba(0,0,0,0.5)] transition-transform duration-300 ease-spring">
        <div className="grid grid-cols-2 gap-4 max-w-md mx-auto">
          {currentView === 'telemetry' ? (
            <>
              <button 
                onClick={() => { setCurrentView('history'); SoundFX.play('click'); }}
                className="skew-f1 bg-[#2A2A35] border border-gray-600 text-gray-300 font-bold py-4 uppercase tracking-wider hover:bg-gray-700 transition-colors"
              >
                <div className="unskew-f1 text-sm">赛季记录 / History</div>
              </button>
              <button 
                onClick={handleSave}
                className="skew-f1 bg-[#E10600] text-white font-bold py-4 uppercase tracking-wider shadow-[0_0_20px_rgba(225,6,0,0.5)] active:scale-95 transition-transform"
              >
                <div className="unskew-f1 text-sm">进站确认 / BOX</div>
              </button>
            </>
          ) : (
             <button 
                onClick={() => { setCurrentView('telemetry'); SoundFX.play('click'); }}
                className="col-span-2 skew-f1 bg-[#E10600] text-white font-bold py-4 uppercase tracking-wider shadow-[0_0_20px_rgba(225,6,0,0.5)] active:scale-95 transition-transform"
              >
                <div className="unskew-f1">返回遥测 / Return</div>
              </button>
          )}
        </div>
      </div>

      <Modal />
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
