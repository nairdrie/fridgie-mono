import { useLists } from '@/context/ListContext';
import { List, ListView } from '@/types/types';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Dimensions,
  FlatList,
  LayoutChangeEvent,
  Platform,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from 'react-native';
import Modal from 'react-native-modal';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { getWeekLabel } from '../utils/date';
import UserProfile from './UserProfile';

const DEVICE_HEIGHT =
  Dimensions.get('window').height + (Platform.OS === 'android' ? (StatusBar?.currentHeight ?? 0) : 0);

// TODO: The android top statusbar is hidden? 
export default function ListHeader() {
  const router = useRouter();
  const { allLists, selectedList, selectList, selectedView, selectView } = useLists();
  const [isModalVisible, setModalVisible] = useState(false);

 // State to hold the width of a single segment for the animation
  const [segmentWidth, setSegmentWidth] = useState(0);
  

  const handleSelectList = (list: List) => {
    setModalVisible(false);
    selectList(list);
  };
  
  // This function captures the width of the segment on layout
  const onSegmentLayout = (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setSegmentWidth(width);
  };
  
  // Animated style for the sliding background
  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateX: withTiming(selectedView === ListView.GroceryList ? 0 : segmentWidth, {
            duration: 250, // Animation speed
          }),
        },
      ],
    };
  });

  if(!selectedList) 
    return <></>;

  return (
    <>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.container}>
          <View style={styles.headerLeft}>
            {/* {router.canGoBack() && (
              <TouchableOpacity onPress={() => router.back()} style={styles.backNav}>
                <Ionicons name="chevron-back" size={28} color="#007AFF" />
                <Text style={styles.backNavText}>Groups</Text>
              </TouchableOpacity>
            )} */}
            {/* WEEK SELECTOR */}
            <View style={styles.weekSelector}>
              <Pressable onPress={() => setModalVisible(true)} style={styles.weekSelectorInner}>
                <Text style={styles.title}>{getWeekLabel(selectedList.weekStart)}</Text>
                <Text style={styles.subtitle}>
                  {new Date(selectedList.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date(new Date(selectedList.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </Text>
              </Pressable>
            </View>
            {/* VIEW SELECTOR */}
            <View style={styles.viewSelector}>
              {segmentWidth > 0 && (
                <Animated.View style={[styles.activeSegmentBackground, { width: segmentWidth }, animatedStyle]} />
              )}
              <TouchableOpacity
                style={styles.segment}
                onLayout={onSegmentLayout} // Measure the first segment
                onPress={() => selectView(ListView.GroceryList)}
              >
                <Text style={[styles.segmentText, selectedView === ListView.GroceryList && styles.segmentTextActive]}>List</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.segment}
                onPress={() => selectView(ListView.MealPlan)}
              >
                <Text style={[styles.segmentText, selectedView === ListView.MealPlan && styles.segmentTextActive]}>Meals</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.headerRight}>
            <UserProfile/>
          </View>
      </View>
      </SafeAreaView>
      <View>
          <Modal
            isVisible={isModalVisible}
            onBackdropPress={() => setModalVisible(false)}
            onBackButtonPress={() => setModalVisible(false)}   // Android back
            swipeDirection="down"
            onSwipeComplete={() => setModalVisible(false)}
            backdropOpacity={0.4}
            style={styles.modal}               // { justifyContent: 'flex-end', margin: 0 }
            statusBarTranslucent               // Android: draw under status bar
            coverScreen                        // ensure full-screen overlay (default true, explicit here)
            deviceHeight={DEVICE_HEIGHT}       // avoids being “short” inside a custom header
            useNativeDriverForBackdrop
            useNativeDriver={false}
          >
            <View style={styles.sheet}>
              {/* little grabber for UX */}
              <View style={{ alignItems: 'center', paddingBottom: 8 }}>
                <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0E0E0' }} />
              </View>

              <Text style={styles.sheetTitle}>Select a Week</Text>

              <FlatList
                data={allLists}
                keyExtractor={(list) => list.id}
                contentContainerStyle={{ paddingBottom: 16 }}
                renderItem={({ item }) => (
                  <TouchableOpacity onPress={() => handleSelectList(item)} style={styles.weekItem}>
                    <View>
                      <Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text>
                      <Text style={styles.weekRange}>
                        {new Date(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} -{' '}
                        {new Date(new Date(item.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(
                          undefined,
                          { month: 'short', day: 'numeric' }
                        )}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
                // If list is long, allow inside scroll without closing the sheet
                // react-native-modal handles scroll/propagation well
              />
            </View>
          </Modal>
      </View>
    </>
  );
}

// ✅ Complete style overhaul
const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#fff', // Match your header background
  },
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Constants.statusBarHeight, // Handles status bar height
    paddingHorizontal: 20,
  },
  backNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    color: '#007AFF'
  },
  backNavText: {
    color: '#007AFF',
    fontSize: 16
  },
  headerLeft: {
  },
  headerRight: {
  },
  weekSelector: {

  },
  viewSelector: {
    flexDirection: 'row',
    backgroundColor: '#f0f0f0', // Lighter background
    borderRadius: 10, // More rounded
    height: 36,
    position: 'relative',
    justifyContent: 'flex-start',
    width:'100%'
  },
  weekSelectorInner: {
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  title: {
    fontSize: 24, // Bigger title
    fontWeight: 'bold',
    paddingTop: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#007AFF', // Subtler color
  },
  segment: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8e8e93', // Grayer unselected text
  },
  segmentTextActive: {
    color: '#000', // Black selected text
  },
  activeSegmentBackground: {
    position: 'absolute',
    backgroundColor: '#fff', // White active background
    borderRadius: 8,
    margin: 2,
    height: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  modal: { justifyContent: 'flex-end', margin: 0 },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%' },
  sheetTitle: { fontWeight: '600', fontSize: 18, marginBottom: 12, textAlign: 'center' },
  weekItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  weekText: { fontSize: 16 },
  weekRange: { fontSize: 12, color: '#666', paddingTop: 4 },
});