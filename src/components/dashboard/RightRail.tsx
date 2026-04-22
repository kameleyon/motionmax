import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const mockVoices = [
  { id: 1, name: "Jomama", tag: "CLONE", desc: "EN · WARM · READY", bg: "from-[#14C8CC] to-[#0FA6AE]", initial: "J" },
  { id: 2, name: "Ava", desc: "EN · DOCUMENTARY", bg: "from-[#14C8CC] to-[#0FA6AE]", initial: "A" },
  { id: 3, name: "Léo", desc: "FR · NARRATOR", bg: "from-[#c593ff] to-[#7c4dcf]", initial: "L" }
];

export default function RightRail() {
  const queryClient = useQueryClient();

  const { data: renderQueue = [] } = useQuery({
    queryKey: ['rightrail-generations'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('generations')
        .select('id, status, progress, project_id, created_at')
        .order('created_at', { ascending: false })
        .limit(4);
      if (error) throw error;
      return data;
    }
  });

  useEffect(() => {
    const channel = supabase
      .channel('rightrail_generations_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'generations' }, () => {
        queryClient.invalidateQueries({ queryKey: ['rightrail-generations'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);

  const getStatusDisplay = (gen) => {
    if (['pending', 'processing', 'generating'].includes(gen.status)) return { text: `${gen.progress || 0}%`, state: 'active' };
    if (gen.status === 'completed' || gen.status === 'done') return { text: 'DONE', state: 'done' };
    return { text: gen.status.toUpperCase(), state: 'queued' };
  };
  return (
    <aside className="flex flex-col gap-3.5">
      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.2)]"></span>Credits
        </h4>
        <div className="flex items-baseline gap-2.5 mb-3.5">
          <b className="font-serif text-[36px] tracking-tight font-normal text-[#ECEAE4]">996,794</b>
          <span className="font-mono text-[11px] text-[#5A6268] tracking-widest">/ 2,500,000</span>
        </div>
        <div className="h-1.5 rounded-full bg-[#1B2228] relative border border-white/5 overflow-hidden">
          <i className="block w-[40%] h-full bg-[#14C8CC] rounded-full"></i>
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[25%]"></div>
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[50%]"></div>
          <div className="absolute top-[-2px] w-[2px] h-2.5 bg-[#8A9198] opacity-35 left-[75%]"></div>
        </div>
        <div className="flex justify-between mt-2.5 font-mono text-[10px] text-[#5A6268] tracking-widest">
          <span>Used this month</span><span>40%</span>
        </div>
        <div className="flex items-end gap-[3px] h-7 mt-3.5" aria-hidden="true">
          {/* Mock sparkline data */}
          {[20,35,22,48,30,78,42,60,38,55,72,46,32,55,88,48,40,58,68,44,36,52,80,50,42,38,55,70,48,60].map((val, i) => (
            <b key={i} className={`flex-1 block rounded-[2px] min-h-[2px] ${val > 60 ? 'bg-gradient-to-b from-[#14C8CC] to-[#0FA6AE]' : 'bg-white/20'}`} style={{ height: `${val}%` }}></b>
          ))}
        </div>
        <div className="flex justify-between items-center mt-3.5 pt-3.5 border-t border-white/5 text-[12px] text-[#8A9198]">
          <span className="font-mono text-[10px] tracking-widest uppercase px-2 py-1 rounded bg-[#14C8CC]/10 text-[#14C8CC]">Studio plan</span>
          <a className="font-mono text-[10.5px] tracking-wider uppercase text-[#14C8CC] cursor-pointer">Top up →</a>
        </div>
      </div>

      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.3)]"></span>Render queue
        </h4>
        <div className="flex flex-col">
          {renderQueue.length === 0 ? (
            <div className="text-[12.5px] text-[#5A6268] py-2">No active renders</div>
          ) : renderQueue.map((item, i) => {
            const display = getStatusDisplay(item);
            return (
              <div key={item.id} className={`flex items-center gap-2.5 py-2.5 ${i > 0 ? 'border-t border-white/5' : ''}`}>
                <span className={`w-2 h-2 rounded-full shrink-0 ${display.state === 'active' ? 'bg-[#14C8CC] animate-pulse shadow-[0_0_0_4px_rgba(20,200,204,0.3)]' : display.state === 'done' ? 'bg-[#5CD68D]' : 'bg-[#5A6268]'}`}></span>
                <span className="flex-1 min-w-0 text-[12.5px] text-[#ECEAE4] whitespace-nowrap overflow-hidden text-ellipsis">{item.project_id ? `Project ${item.project_id.slice(0, 4)}` : 'Generation'}</span>
                <span className={`font-mono text-[10px] tracking-wider ${display.state === 'active' ? 'text-[#14C8CC]' : 'text-[#5A6268]'}`}>{display.text}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[#14C8CC] shadow-[0_0_0_3px_rgba(20,200,204,0.14)]"></span>Voice lab
        </h4>
        <div className="flex flex-col">
          {mockVoices.map((voice, i) => (
            <div key={voice.id} className={`flex items-center gap-2.5 py-2.5 ${i > 0 ? 'border-t border-white/5' : ''}`}>
              <div className={`w-7 h-7 rounded-full grid place-items-center font-serif text-[12px] text-[#0A0D0F] font-semibold bg-gradient-to-br ${voice.bg}`}>
                {voice.initial}
              </div>
              <div className="flex-1">
                <div className="text-[12.5px] text-[#ECEAE4]">
                  {voice.name}
                  {voice.tag && <span className="text-[#14C8CC] font-mono text-[9.5px] ml-1 tracking-widest">{voice.tag}</span>}
                </div>
                <div className="font-mono text-[9.5px] text-[#5A6268] tracking-widest mt-px">{voice.desc}</div>
              </div>
              <div className="flex items-center gap-[1.5px] h-[18px]">
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '40%'}}></b>
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '70%'}}></b>
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '55%'}}></b>
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '85%'}}></b>
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '50%'}}></b>
                <b className={`w-[2px] rounded-[1px] ${voice.id === 1 ? 'bg-[#14C8CC]' : 'bg-white/20'}`} style={{height: '30%'}}></b>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border border-white/5 rounded-2xl bg-[#10151A] p-[18px_20px]">
        <h4 className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] m-0 mb-3 font-medium">This week</h4>
        <div className="grid grid-cols-2 gap-2.5 font-serif">
          <div>
            <div className="text-[28px] text-[#ECEAE4] tracking-tight">14</div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Videos rendered</div>
          </div>
          <div>
            <div className="text-[28px] text-[#ECEAE4] tracking-tight">2:34<span className="text-[14px] text-[#5A6268]">:18</span></div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Total runtime</div>
          </div>
          <div>
            <div className="text-[28px] text-[#14C8CC] tracking-tight">+42%</div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">vs last week</div>
          </div>
          <div>
            <div className="text-[28px] text-[#14C8CC] tracking-tight">7</div>
            <div className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-[#5A6268] font-sans">Languages used</div>
          </div>
        </div>
      </div>
    </aside>
  );
}