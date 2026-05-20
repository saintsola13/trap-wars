import { useApp } from '../context/AppContext';

export function Toast() {
  const { toast } = useApp();
  return (
    <div className={`toast${toast.visible ? ' show' : ''}`}>
      {toast.msg}
    </div>
  );
}
