import { canvas } from '@/utils/styles';
import { Stack } from 'expo-router';

export default function PrintCookbookLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: canvas } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="orders" />
      <Stack.Screen name="orders/[orderId]" />
    </Stack>
  );
}
