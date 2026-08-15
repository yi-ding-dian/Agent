import { Sidebar } from './Sidebar';
import { ChatWindow } from '../chat/ChatWindow';

export function AppLayout() {
  return (
    <div className="app-layout">
      <Sidebar />
      <ChatWindow />
    </div>
  );
}
