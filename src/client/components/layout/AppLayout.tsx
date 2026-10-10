import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ChatWindow } from '../chat/ChatWindow';

export function AppLayout() {
  return (
    <div className="app-layout">
      <Sidebar />
      {/*
        主区 = 顶栏 + 对话区。
        Header 原先由 ChatWindow（业务域）渲染 —— 那是"业务域引用壳组件"的层级倒置，
        check-boundaries 会报违规。提到这里与 Sidebar 平级；
        .app-main 的样式与 .chat-area 同构（flex column + flex:1），故视觉不变。
      */}
      <div className="app-main">
        <Header />
        <ChatWindow />
      </div>
    </div>
  );
}
