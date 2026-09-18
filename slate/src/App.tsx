import { useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import NewRequest from './NewRequest'
import StudentDashboard from './StudentDashboard'
import TeacherDashboard from './TeacherDashboard'
import './App.css'

type Tab = 'new-request' | 'student' | 'teacher'

function App() {
  const [tab, setTab] = useState<Tab>('student')

  return (
    <Authenticator>
      {({ user, signOut }) => (
        <div className="app-shell">
          <nav className="tabs">
            <button className={tab === 'student' ? 'active' : ''} onClick={() => setTab('student')}>
              My Timetable
            </button>
            <button className={tab === 'teacher' ? 'active' : ''} onClick={() => setTab('teacher')}>
              My Teaching Timetable
            </button>
            <button
              className={tab === 'new-request' ? 'active' : ''}
              onClick={() => setTab('new-request')}
            >
              Schedule a Session
            </button>
            <button className="sign-out" onClick={signOut}>
              Sign out
            </button>
          </nav>

          {tab === 'student' && <StudentDashboard />}
          {tab === 'teacher' && <TeacherDashboard />}
          {tab === 'new-request' && <NewRequest requesterId={user?.userId ?? ''} />}
        </div>
      )}
    </Authenticator>
  )
}

export default App
