import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';

export const LogViewer: React.FC<{
    logs: string[];
    getExportLogs?: () => string[];
    filePrefix?: string;
    emptyText?: string;
    onClear?: () => void;
}> = ({ logs, getExportLogs, filePrefix = 'unique', emptyText = 'Đang chờ.', onClear }) => {
    const endRef = useRef<HTMLDivElement>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        const box = endRef.current?.parentElement;
        if (box) box.scrollTop = box.scrollHeight;
    }, [logs]);

    const saveLogs = () => {
        const exported = getExportLogs ? getExportLogs() : logs;
        const text = exported.length ? exported.join('\n') : '(empty log)';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ghostforge-log-${filePrefix}-${stamp}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1600);
    };

    return (
        <div className="relative">
            <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
                {onClear && (
                    <button
                        type="button"
                        onClick={onClear}
                        title="Xóa log của riêng bảng này"
                        className="px-2 py-1 rounded-md text-[10px] font-semibold border border-gray-700 bg-gray-900/90 text-gray-300 hover:text-white hover:border-red-500"
                    >
                        Xóa
                    </button>
                )}
                <button
                    type="button"
                    onClick={saveLogs}
                    title="Xuất log của riêng bảng này, gồm các dòng đã cuộn khỏi màn hình"
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold border border-gray-700 bg-gray-900/90 text-gray-300 hover:text-white hover:border-purple-500"
                >
                    <Download className="w-3 h-3" />
                    {saved ? 'Saved' : 'Save log .txt'}
                </button>
            </div>
            <div className="bg-black/60 border border-gray-800 rounded-lg p-4 font-mono text-xs h-64 overflow-y-auto flex flex-col gap-1 shadow-inner">
            {logs.length === 0 ? (
                <span className="text-gray-600 italic">{emptyText}</span>
            ) : (
                logs.map((log, i) => {
                    let colorClass = 'text-gray-400';
                    if (log.startsWith('[SYS]')) colorClass = 'text-purple-400 font-semibold';
                    if (log.startsWith('[FFMPEG]')) colorClass = 'text-gray-500';
                    if (log.includes('Error') || log.includes('ERROR') || log.includes('FAILED')) colorClass = 'text-red-400 font-bold';
                    if (log.includes('SUCCESS')) colorClass = 'text-green-400 font-bold';

                    return (
                        <div key={i} className="flex items-start gap-2 break-all">
                            <span className="text-purple-500 opacity-50 shrink-0">{`>`}</span>
                            <span className={colorClass}>{log}</span>
                        </div>
                    );
                })
            )}
            <div ref={endRef} />
        </div>
        </div>
    );
};
