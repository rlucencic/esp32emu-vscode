/*
 * Boards on the network: the machines announce their debugger over mDNS
 * as _esp32emu._tcp (TXT machine=...).
 */
import { Bonjour } from 'bonjour-service';

export interface Board {
    name: string;           /* "Atari 800XL debugger" */
    machine: string;
    host: string;           /* atari-xl.local, or an address */
    address?: string;
    port: number;
}

export function findBoards(timeoutMs = 2500): Promise<Board[]> {
    return new Promise((resolve) => {
        const bonjour = new Bonjour();
        const found = new Map<string, Board>();
        const browser = bonjour.find({ type: 'esp32emu', protocol: 'tcp' }, (s) => {
            const address = s.addresses?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? s.addresses?.[0];
            const host = s.host ? s.host.replace(/\.$/, '') : address ?? '';
            const txt = (s.txt ?? {}) as Record<string, string>;
            found.set(`${host}:${s.port}`, {
                name: s.name,
                machine: txt.machine ?? s.name.replace(/ debugger$/, ''),
                host,
                address,
                port: s.port,
            });
        });
        setTimeout(() => {
            browser.stop();
            bonjour.destroy();
            resolve([...found.values()].sort((a, b) => a.machine.localeCompare(b.machine)));
        }, timeoutMs);
    });
}
