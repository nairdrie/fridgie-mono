import { useLists } from '@/context/ListContext';
import { List } from '@/types/types';
import React, { useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Modal from 'react-native-modal';
import { getWeekLabel } from '../utils/date';

export default function ListHeader() {
  const { allLists, selectedList, selectList } = useLists();
  const [isModalVisible, setModalVisible] = useState(false);

  const handleSelect = (list: List) => {
    setModalVisible(false);
    selectList(list);
  };

  return (
    <View style={styles.wrapper}>
      <View>
        <Text style={styles.title}>Grocery List</Text>
        { selectedList &&
          <Pressable onPress={() => setModalVisible(true)}>
            <Text style={styles.subtitle}>{getWeekLabel(selectedList.weekStart)}</Text>
          </Pressable>
        }
        
      </View>

      <Modal
        isVisible={isModalVisible}
        onBackdropPress={() => setModalVisible(false)}
        backdropOpacity={0.4}
        style={styles.modal}
        avoidKeyboard
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Select a Week</Text>
          <FlatList
            data={allLists}
            keyExtractor={list => list.id}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => handleSelect(item)}
                style={styles.weekItem}
              >
                <View>
                  <Text style={styles.weekText}>{getWeekLabel(item.weekStart)}</Text>
                  <Text style={styles.weekRange}>
                    {new Date(item.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {new Date(new Date(item.weekStart).getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { flexDirection: 'row', alignItems: 'center', marginLeft: -15 },
  title: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 13, color: '#007AFF' },
  modal: { justifyContent: 'flex-end', margin: 0 },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%' },
  sheetTitle: { fontWeight: '600', fontSize: 18, marginBottom: 12, textAlign: 'center' },
  weekItem: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  weekText: { fontSize: 16 },
  weekRange: { fontSize: 12, color: '#666', paddingTop: 4 },
});