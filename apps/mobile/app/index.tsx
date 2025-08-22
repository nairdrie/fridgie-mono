import "@/utils/firebase";
import { Redirect } from 'expo-router';

export default function RootIndex() {
  // This component will immediately redirect the user from the root URL ("/")
  // to your intended starting screen ("/groups").
  return <Redirect href="/groups" />;
}