import './globals.css';
import Link from 'next/link';
export const metadata={title:'AudioHub',description:'Centralized realtime audio broadcasting'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><div className="shell"><aside className="sidebar"><div className="brand">Audio<span>Hub</span></div><nav className="nav"><Link href="/dashboard">Overview</Link><Link href="/broadcast">Broadcast Studio</Link><Link href="/player">Player</Link><Link href="/channels">Channels</Link><Link href="/devices">Devices</Link></nav></aside><main className="main">{children}</main></div></body></html>}
