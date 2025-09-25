import { useLists } from '@/context/ListContext';
import { List, ListView } from '@/types/types';
import { primary } from '@/utils/styles';
import Ionicons from '@expo/vector-icons/Ionicons';
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
import Animated, { interpolate, interpolateColor, useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';
import { getWeekLabel } from '../utils/date';
import GroupIndicator from './GroupIndicator';

const DEVICE_HEIGHT =
  Dimensions.get('window').height + (Platform.OS === 'android' ? (StatusBar?.currentHeight ?? 0) : 0);

export default function ListHeader() {
  const router = useRouter();
  const { allLists, selectedList, selectList, selectedView, selectView } = useLists();
  const [isModalVisible, setModalVisible] = useState(false);

 // State to hold the width of a single segment for the animation
  const [segmentWidth, setSegmentWidth] = useState(0);

  // const [activeView, setActiveView] = useState(selectedView);

  // useEffect(() => {
  //   setActiveView(selectedView);
  // }, [selectedView]);
  

  const handleSelectList = (list: List) => {
    setModalVisible(false);
    selectList(list);
  };
  
  // This function captures the width of the segment on layout
  const onSelectorLayout = (event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    setSegmentWidth(width / 2);
  };


  // ✅ 1. Add the dependency array to useDerivedValue.
  // This tells the hook to re-create the animation value whenever `selectedView` changes.
  const progress = useDerivedValue(() => {
    return withTiming(selectedView === ListView.GroceryList ? 0 : 1, { duration: 250 });
  }, [selectedView]); // <--- THE FIX IS HERE

  // ✅ 2. Drive the background animation from the `progress` value for perfect sync.
  // This is more efficient and reliable than using a separate React state variable.
  const animatedStyle = useAnimatedStyle(() => {
    // Interpolate maps the progress (0 to 1) to the pixel translation (0 to segmentWidth)
    const translateX = interpolate(
      progress.value,
      [0, 1],
      [2, segmentWidth - 2] // Using a small margin for better centering
    );

    return {
      transform: [{ translateX }],
    };
  });

   const listTextStyle = useAnimatedStyle(() => {
    const color = interpolateColor(
      progress.value,
      [0, 1], // Input Range
      ['#FFFFFF', '#000000'] // Output Color (Active -> Inactive)
    );
    return {
      color: color,
    };
  });

  const mealsTextStyle = useAnimatedStyle(() => {
    const color = interpolateColor(
      progress.value,
      [0, 1], // Input Range
      ['#000000', '#FFFFFF'] // Output Color (Inactive -> Active)
    );
    return {
      color: color,
    };
  });

  if(!selectedList) 
    return <></>;

  return (
    <>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.container}>
          <View style={styles.headerUpper}>
              {/* WEEK SELECTOR */}
              <View style={styles.weekSelector}>
                <Pressable onPress={() => setModalVisible(true)} style={styles.weekSelectorInner}>
                  <Ionicons size={30} color={primary} name="calendar-outline"></Ionicons>
                  <View style={styles.weekSelectorText}>
                    <Text style={styles.title}>{getWeekLabel(selectedList.weekStart)}</Text>
                    <Text style={styles.subtitle}>
                      {new Date(selectedList.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date(new Date(selectedList.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </Text>
                  </View>
                  
                </Pressable>
              </View>
              <GroupIndicator />
          </View>
          <View style={styles.headerLower}>
              {/* VIEW SELECTOR */}
            <View style={styles.viewSelector} onLayout={onSelectorLayout}>
              {segmentWidth > 0 && (
                <Animated.View style={[styles.activeSegmentBackground, { width: segmentWidth }, animatedStyle]} />
              )}
              <TouchableOpacity
                style={styles.segment}
                onPress={() => selectView(ListView.GroceryList)}
              >
                <Animated.Text style={[styles.segmentText, listTextStyle]}>
                  &nbsp;&nbsp;Grocery List
                </Animated.Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.segment}
                onPress={() => selectView(ListView.MealPlan)}
              >
                  <Animated.Text style={[styles.segmentText, mealsTextStyle]}>
                  Meal Plan
                </Animated.Text>
                </TouchableOpacity>
              </View>
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
                    <View style={styles.weekSelectRow}>
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
                      { item.id === selectedList?.id ? (
                        <Ionicons name="checkmark-circle" size={20} color={primary} />
                      ) : (
                        <Ionicons name="ellipse-outline" size={20} color={primary} />
                      )}
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

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#fff', // Match your header background
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2, // Shadow moves downwards
    },
    shadowOpacity: 0.1, // Shadow is 10% opaque
    shadowRadius: 3, // Blurs the shadow
    // Android shadow prop
    elevation: 5,
  },
  container: {
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 12
  },
  backNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    color: primary
  },
  backNavText: {
    color: primary,
    fontSize: 16
  },
  headerUpper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  headerLower: {
    flexDirection: 'row'
  },
  weekSelector: {
    
  },
  weekSelectorInner: {
    alignItems: 'center',
    marginBottom: 16,
    flexDirection: 'row'
  },
  weekSelectorText: {
    marginLeft: 8
  },
  weekSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  title: {
    fontSize: 22, // Bigger title
    fontWeight: 'bold',
    paddingTop: 4,
    marginBottom:-4
  },
  subtitle: {
    fontSize: 14,
    color: primary, // Subtler color
  },
    viewSelector: {
    flexDirection: 'row',
    // backgroundColor: '#f0f0f0', // Lighter background
    borderRadius: 10, // More rounded
    height: 36,
    position: 'relative',
    justifyContent: 'flex-start',
    width:'100%'
  },
  segment: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  segmentText: {
    fontSize: 16,
    fontWeight: '600',
    // color: '#043308ff', // Grayer unselected text
  },
  segmentTextActive: {
    // color: 'white', // Black selected text
  },
  activeSegmentBackground: {
    position: 'absolute',
    backgroundColor: primary, // White active background
    borderRadius: 20,
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